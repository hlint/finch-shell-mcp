# Interface contract

Requests, responses, and the cases that must be rejected for the ten tools. The implementation notes are in the [development guide](02-development.md).

A business failure is text inside the tool result: `{ ok: false, error: { code, message } }`. A non-zero command exit is still `ok: true`. Read `status` and `exit_code`.

## Files

## 0. Common rules

### 0.1 The five file tools

| Tool | In one line | Data |
|---|---|---|
| `fs_stat` | Attributes and a short hash, many paths at once | — |
| `fs_read` | Read by byte offset | text / hex |
| `fs_write` | Replace a whole file | text / hex |
| `fs_patch` | Replace an exact text fragment | text only |
| `fs_splice` | Insert or delete at a byte offset | text or hex, one of them |

The tools do not overlap:

- `fs_patch` sees text. It is given `old_text` / `new_text` and does not interpret bytes.
- `fs_splice` sees bytes. It is given `offset` / `delete_bytes` / `insert_hex` and does not interpret text.
- The caller chooses which tool to use. The server does not guess.

Not provided: `list_directory`, `glob`, `grep`, `move`, `copy`, `delete`, `mkdir`, `chmod`, `append`, `lock`.

### 0.2 Response envelope

Success: `{ "ok": true, "data": { ... } }`

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "E_HASH_MISMATCH",
    "message": "The file changed after you read it. The write was cancelled and not a byte on disk was touched.",
    "hint": "Read the file again with fs_read, then retry.",
    "context": { "expect": "a3f1c7", "actual": "9c02be" }
  }
}
```

- `message` is a sentence for a person. `hint` is the next step for an agent and may be omitted.
- `context` is machine-readable. It must not contain file contents. It may contain hashes, offsets, and lengths.
- Error codes are stable. Wording may change. Callers branch on `code` only.

### 0.3 Paths

1. Only absolute paths are accepted. On Windows the path must be a drive or UNC path. `/` and `\` are equivalent and are normalized to `\`. On POSIX the path must start with `/`. A relative path is `E_INVALID_ARG`.
2. Normalization resolves `.` and `..` and collapses repeated separators. On Windows, trailing spaces and dots are removed from each segment, and comparison is case-insensitive. POSIX keeps case.
3. On Windows, a path longer than 240 characters gets a `\\?\` prefix.
4. `~`, `%TEMP%`, and environment variables are not expanded.
5. `fs_stat` does not follow symlinks. The other tools do, and the response includes `resolved_path`.
6. A missing path is `E_NOT_FOUND`. Nothing is created implicitly except when `create_dirs: true`.

### 0.4 One short hash

The algorithm is sha256. Callers see only the first 6 lowercase hex characters.

```
internal: sha256(file) = "a3f1c7d9e0b2..." (64 hex digits)
external: "a3f1c7" (6 hex digits)
```

- There is no algorithm option and no length option.
- `expect_hash` is 6 digits. It is compared with the first 6 hex digits of the current file's full sha256. The hash is still of the whole file.
- `"absent"` means the target must not exist.

Collision odds, stated here on purpose:

| Digits | Space | Chance of a collision among 4096 hashes |
|---|---|---|
| 6 | 2^24 | ~0.4% |
| 8 | 2^32 | ~0.0002% |

1. Comparing versions of one file is sound. Changing one byte changes the sha256, and the first 6 digits change with it.
2. Comparing hundreds of paths from one `fs_stat` can theoretically collide. The chance is small. A longer hash is not offered.

### 0.5 Three rules

1. Atomic: a reader sees the complete old contents or the complete new contents.
2. Proven: a write is success only after a real read-back comparison, with `verified: true`.
3. Not silent: anything that did not do what the caller asked is an error.

### 0.6 `expect_hash` is the optimistic lock

There is no lease. Two callers can each read and each write, and the later write would otherwise win. `expect_hash` already stops that.

```
A reads → hash=H0        B reads → hash=H0
A writes expect_hash=H0 → success, hash=H1
B writes expect_hash=H0 → E_HASH_MISMATCH, disk unchanged
```

Writes that do not go through these tools are not protected. A shell redirect, `Out-File`, or `Set-Content` lands on disk and `expect_hash` never sees it.

The check runs after the read and before `rename`. A third writer in that gap is overwritten by the rename. The window is reduced by stating size and mtime again just before rename. That is one extra system call. It is not a claim of a zero-width window.

### 0.7 Bytes are hex

Bytes are a hexadecimal string, not base64.

1. 1 byte is exactly 2 characters. Offset times 2 is the string index. Base64 is 3 bytes to 4 characters and does not line up.
2. The value can be compared with a hex editor.
3. There is no implicit padding and no alphabet variant.
4. Structure is visible. `504b0304` is a ZIP local header. `4d5a` is a PE header.

The cost is about 50% more than base64. At the 2 MB cap, hex is a 4 MB string.

- Case is ignored on input. Output is lowercase.
- No spaces, no `0x`, no `\x`. Output is compact. Input such as `"4D 5A 90 00"` is accepted and the spaces are removed.
- An odd length is `E_INVALID_ARG`.
- Base64 fields are rejected. `data_base64` and `insert_base64` are `E_INVALID_ARG`.

### 0.8 `hash_max_bytes` is 64 MB

This is a constant, not a parameter. Above 64 MB, `fs_stat` returns `hash: null, hash_skipped: "too_large"`, and `fs_read` omits `hash`. That is not an error. Large files can still be read and written. They just have no pre-check credential.

### 0.9 Encoding uses a library

Detection stops at the first hit:

1. BOM, confidence `bom`.
2. Strict UTF-8, confidence `valid-utf8`.
3. A NUL-byte ratio that looks like UTF-16LE or UTF-16BE, confidence `heuristic`.
4. The platform charset (Windows `chcp`, POSIX `LANG` / `LC_ALL`) decodes the sample without loss, confidence `heuristic`.
5. Charset detection on the first 128 KB decodes without loss, confidence `heuristic`.
6. Otherwise decode as UTF-8, replace unrecognized bytes, `lossy: true`, confidence `fallback`.

`lossy` means the bytes do not round-trip. A U+FFFD that was already in the text is not damage. An explicit charset is used as given. A failed decode still does not fail the call. It sets `lossy` to `true`.

A decode failure is never an error by itself.

Charsets that can be named: `utf-8`, `utf-8-bom` (write side only), `utf-16-le`, `utf-16-be`, `gbk`, `gb18030`, `big5`, `shift_jis`, `euc-jp`, `euc-kr`, `latin-1`.

### 0.10 Two checks, and one of them cannot be turned off

| Layer | When | Can it be disabled | What it stops |
|---|---|---|---|
| `expect_hash` (before) | After the read, before the write | Yes. The default `null` skips it | Overwriting a file someone else just wrote |
| `verified` (read back) | After the write | No. There is no parameter | Disk, encoding, or splice mistakes |

`verified` is the definition of success. A write that does not read back has only shown that the bytes were sent, not that they landed.

---

## 1. `fs_stat`

### Request

```json
{ "paths": ["D:\\workspace\\a.txt"], "hash": true }
```

| Field | Default | Meaning |
|---|---|---|
| `paths` | required | 1 to 200 paths |
| `hash` | `true` | `false` returns size and times only |

### Response

```json
{
  "entries": [
    {
      "path": "D:\\workspace\\a.txt",
      "exists": true,
      "type": "file",
      "size": 15234,
      "mtime": "2026-11-07T13:20:00.123Z",
      "ctime": "2026-11-05T08:00:00.000Z",
      "readonly": false,
      "hash": "a3f1c7",
      "encoding": { "charset": "utf-8", "bom": true, "eol": "crlf", "confidence": "bom" },
      "is_binary": false
    },
    { "path": "D:\\workspace\\b.txt", "exists": false }
  ]
}
```

- Order matches the input. A missing path is still an entry, not an error. A path that cannot be read gets `error_code` on that entry.
- `type` is `file`, `dir`, `symlink`, or `other`.
- `encoding` is detected only when `type` is `file`, `size` is at most 1 MB, and `is_binary` is false. Otherwise it is `null`.
- `is_binary` is true when the first 8 KB contains a NUL or detection cannot treat the sample as text.
- A directory hash is always `null`. Above 64 MB the entry is `hash: null, hash_skipped: "too_large"`.

---

## 2. `fs_read`

Reads by byte offset, not by line. A line is a text idea, and the file may not be text.

### Request

```json
{
  "path": "D:\\workspace\\a.txt",
  "offset": 0,
  "length": null,
  "mode": "auto",
  "encoding": "auto",
  "include_bom": false,
  "max_bytes": 2097152
}
```

| Field | Default | Meaning |
|---|---|---|
| `offset` | 0 | Byte offset, not a line number. Negative counts from the end |
| `length` | `null` | Byte count. `null` reads until `max_bytes` or EOF |
| `mode` | `auto` | `text`, `hex`, or `auto` |
| `encoding` | `auto` | `auto` detects. An explicit value skips detection and decodes with that charset |
| `include_bom` | `false` | When true and the file has a BOM, `text` starts with U+FEFF. When false, that character is removed. This does not affect `offset_aligned` |
| `max_bytes` | 2 MB | Cap for one response |

### Text response

```json
{
  "path": "D:\\workspace\\a.txt",
  "mode": "text",
  "text": "line one\r\nline two\r\n",
  "encoding_used": "utf-8",
  "encoding_source": "detected",
  "encoding_confidence": "bom",
  "lossy": false,
  "bom": true,
  "eol": "crlf",
  "offset": 0,
  "offset_aligned": true,
  "bytes_read": 22,
  "total_size": 15234,
  "eof": false,
  "remaining": 15212,
  "hash": "a3f1c7"
}
```

### Hex response

```json
{
  "path": "D:\\workspace\\mod.esp",
  "mode": "hex",
  "hex": "5445533400000100",
  "offset": 0,
  "bytes_read": 8,
  "total_size": 4407296,
  "eof": false,
  "remaining": 4407288,
  "hash": "7e40aa"
}
```

In hex mode, `offset` is the `hex` index divided by 2. `encoding` and `include_bom` are ignored.

### Rules

1. Decoding never fails the call. An explicit `encoding` is used as given. If it cannot represent the bytes, `lossy` is true and replacement characters are used.
2. `encoding_source` is `bom`, `detected`, or `explicit`.
3. Truncation is not silent. Past `max_bytes`, `eof` is false and `remaining` is set.
4. With `include_bom: false`, `text` does not contain U+FEFF. `bom: true` still reports that the file has one.
5. `mode: "text"` on binary content is `E_NOT_TEXT`. `auto` switches to hex.
6. `offset_aligned` is true only when both the start and the end of this byte window fall on character boundaries. A start in the middle of a multibyte character, or a `length` that cuts a character, makes it false. The text may contain a replacement character and `lossy` is true. That is not an error. When the file is valid UTF-8 and the window covers the whole file, `lossy` is false. A U+FFFD that was already in the file is not damage. The server does not append a truncation marker to `text`. Use `eof` and `remaining`.
7. `hash` is always the short hash of the whole file, for a later `expect_hash`.
8. `fs_read` has no `dropped_chars`. That field belongs to job logs. It counts code points that slid out of the memory ring. It does not mean this file read dropped bytes.

---

## 3. `fs_write`

### 3.1 What it is

Replaces the whole file. It creates the file or overwrites it. It does not edit the old contents in place.

### 3.2 Text encoding and BOM

The decode-then-encode path is explicit.

| Field | Default | Meaning |
|---|---|---|
| `encoding` | `utf-8` | Encodes `text` with this charset |
| `preserve.bom` | `keep` | `keep`, `add`, `strip`, or `as_is` |
| `preserve.eol` | `as_is` | `keep`, `crlf`, `lf`, or `as_is` |

| `preserve.bom` | Old file has a BOM | Old file has no BOM | Old file does not exist |
|---|---|---|---|
| `keep` | write a BOM | do not write one | do not write one |
| `add` | write a BOM | write a BOM | write a BOM |
| `strip` | do not write one | do not write one | do not write one |
| `as_is` | write one if `text` starts with U+FEFF | same | same |

A BOM is meaningful for `utf-8`, `utf-16-le`, and `utf-16-be`. `add` on a charset with no BOM, such as `gbk` or `latin-1`, is `E_INVALID_ARG`.

`preserve.eol: "keep"` rewrites bare `\n` in `text` to the old file's newline style. An existing `\r\n` is not converted again. `as_is` leaves every byte of the newline as given.

### 3.3 Three encoding checks

1. Unrepresentable characters (`E_ENCODING_UNREPRESENTABLE`). The text is encoded and decoded again. A mismatch means a character cannot be stored in that charset, for example an emoji in a GBK file. `context` names the first bad character. It must not become `?`.
2. The BOM bytes match the request. Asking for a BOM writes `efbbbf`, `fffe`, or `feff` at the front. Asking for none writes no extra byte. The read-back checks this.
3. Read-back (`verified`) cannot be turned off. The file is opened again and the hash is compared with the expected bytes. A mismatch is `E_VERIFY_FAILED`. A matching hash means the bytes are identical, including the BOM and newlines.

### 3.4 Binary writes are not transformed

On the `hex` path, `encoding`, `preserve.bom`, and `preserve.eol` do nothing. To write a BOM, put `efbbbf` in `hex`.

### 3.5 Request

```json
{
  "path": "D:\\workspace\\a.txt",
  "text": "new contents\r\n",
  "encoding": "gbk",
  "expect_hash": "a3f1c7",
  "preserve": { "bom": "keep", "eol": "keep" },
  "create_dirs": true
}
```

| Field | Default | Meaning |
|---|---|---|
| `text` | — | Text. Exactly one of `text` or `hex`. Both is `E_INVALID_ARG` |
| `hex` | — | Raw bytes |
| `encoding` | `utf-8` | Applies to `text` only |
| `expect_hash` | `null` | `null` skips the check. `"absent"` requires the file to be missing. Otherwise it must match. A `hex` write that omits it is `E_HASH_REQUIRED` unless `force: true` |
| `preserve.bom` | `keep` | See §3.2 |
| `preserve.eol` | `as_is` | See §3.2 |
| `create_dirs` | `true` | Create missing parent directories |
| `force` | `false` | Used when a `hex` write omits `expect_hash` |

### 3.6 Response

```json
{
  "path": "D:\\workspace\\a.txt",
  "created": false,
  "bytes_written": 22,
  "hash_before": "a3f1c7",
  "hash_after": "5b8e02",
  "verified": true,
  "encoding": "gbk",
  "bom": false,
  "eol": "crlf",
  "dirs_created": []
}
```

`bom` and `eol` are what the read-back observed, not an echo of the request.

### 3.7 Rules

1. A mismatched `expect_hash` is `E_HASH_MISMATCH`. Not a byte of the file changes.
2. Replacement is atomic: a temp file in the same directory, fsync, then rename. On failure the old file is intact.
3. `preserve.bom: "keep"` reads the old file. If the file does not exist, `text` is written as given.
4. Every directory `create_dirs` creates is listed in `dirs_created`.
5. There is no `purpose` parameter.

---

## 4. `fs_patch`

### 4.1 What it is

Finds an exact span of text and replaces that span.

It is not a line number, not a regular expression, and not a byte offset.

```
before:  { "host": "localhost", "port": 8080 }
request: old_text = "\"port\": 8080"   new_text = "\"port\": 9090"
after:   { "host": "localhost", "port": 9090 }
```

Every other character stays, including indentation, comments, order, BOM, and newline style.

### 4.2 Encoding and BOM

A patch decodes, replaces strings, re-encodes, and writes atomically.

| Field | Default | Meaning |
|---|---|---|
| `encoding` | `auto` | `auto` uses detection. An explicit value is used to decode and encode |
| `bom` | `keep` | `keep` follows the old file, or `add`, `strip`, or `as_is` |

### 4.3 Round-trip check

Before any replacement:

```
1. Decode the original bytes B to string S with the chosen charset
2. Encode S back to B' with the same charset, without edits
3. B' != B → E_ENCODING_ROUNDTRIP, and context has the first differing byte offset
4. B' == B → the charset is safe for this file, and the edits proceed
```

A wrong charset can damage characters other than the one being edited, and the call would still look successful. The round trip closes that. The cost is one extra encode and decode.

Two more guards:

- Detection confidence `fallback` with no explicit `encoding` is `E_ENCODING_UNSURE`. The server does not guess.
- A character in `new_text` that the charset cannot store is `E_ENCODING_UNREPRESENTABLE`, and the response names the character.

### 4.4 Request

```json
{
  "path": "D:\\workspace\\config.json",
  "expect_hash": "a3f1c7",
  "encoding": "auto",
  "bom": "keep",
  "edits": [
    { "old_text": "\"port\": 8080", "new_text": "\"port\": 9090", "count": 1 }
  ]
}
```

| Field | Default | Meaning |
|---|---|---|
| `edits` | required | At most 50 |
| `edits[].old_text` | required | Must match exactly, including spaces, quotes, and newlines |
| `edits[].new_text` | required | May be `""`, which deletes the span |
| `edits[].count` | 1 | Must be exactly that many occurrences |

### 4.5 Response

```json
{
  "path": "D:\\workspace\\config.json",
  "applied": [ { "index": 0, "occurrences": 1, "byte_offset": 4211, "line": 87 } ],
  "hash_before": "a3f1c7",
  "hash_after": "d0c9e4",
  "verified": true,
  "encoding_used": "utf-8",
  "encoding_source": "explicit",
  "roundtrip_ok": true,
  "bom": false,
  "eol": "lf"
}
```

### 4.6 Rules

1. With `count: 1`, zero matches is `E_NO_MATCH`. More than one is `E_AMBIGUOUS`. `context` includes each byte offset, line number, and a 40-character snippet on either side.
2. Every edit is applied to the same original text. Overlapping ranges are `E_OVERLAP`.
3. All edits succeed or none are written.
4. There is no regex, no fuzzy match, and no whitespace or newline normalization. `\n` in `old_text` does not match a CRLF file.
5. A binary file is `E_NOT_TEXT`. Use `fs_splice`.
6. A file over 8 MB is `E_TOO_LARGE`. A patch goes through a UTF-16 string, so peak memory is several times the file size.

---

## 5. `fs_splice`

### 5.1 What it is

Edits a file by byte position. It does not parse the contents. Appending is `offset: "end"`. Prepending is `"start"`.

### 5.2 Two payloads

There is no separate append tool. The caller should not have to hand-encode text as hex.

Exactly one of these may be set:

| Field | Use | Example |
|---|---|---|
| `insert` plus `encoding` | Text, encoded by the server | `insert: "another line\r\n"` |
| `insert_hex` | Raw bytes | `insert_hex: "0d0a"` |

Both in one request is `E_INVALID_ARG`. Neither, with `delete_bytes > 0`, is a pure delete.

```jsonc
{ "path": "...\\log.txt", "offset": "end", "insert": "2026-11-07 restarted\r\n" }
{ "path": "...\\log.txt", "offset": "end", "insert": "log line\r\n", "encoding": "gbk" }
{ "path": "...\\mod.esp", "offset": "end", "insert_hex": "0d0a" }
```

1. The caller writes the newline. If `insert` has no `\r\n`, none is added.
2. To see whether the file already ends with a newline, read it: `fs_read` with `offset: -2` and `mode: "hex"`.
3. An `insert` the charset cannot store is `E_ENCODING_UNREPRESENTABLE`. It is not written as `?`.

### 5.3 Request

```json
{
  "path": "D:\\workspace\\mod.esp",
  "offset": 0,
  "delete_bytes": 4,
  "insert_hex": "54455334",
  "expect_hash": "7e40aa",
  "force": false
}
```

| Field | Default | Meaning |
|---|---|---|
| `offset` | required | A byte position, `"start"` (0), or `"end"` (file length). Negative counts from the end |
| `delete_bytes` | 0 | How many bytes to delete from `offset` |
| `insert` | — | Text payload. Mutually exclusive with `insert_hex` |
| `insert_hex` | — | Byte payload. Mutually exclusive with `insert` |
| `encoding` | `utf-8` | Applies to `insert` only |
| `expect_hash` | see §5.5 | Hash of the whole file before the edit |
| `force` | `false` | `true` allows a missing `expect_hash` |
| `create_dirs` | `true` | Create missing parent directories |

### 5.4 Result

```
result = original[0, offset) + payload + original[offset + delete_bytes, end)
```

| Combination | Effect |
|---|---|
| `delete_bytes: 0` plus a payload | Insert. `offset: "end"` appends |
| No payload and `delete_bytes: n` | Delete |
| Both | Replace that span |

### 5.5 `expect_hash` is required for an existing file

A damaged binary file often shows no error until much later. The rule is the same for `fs_splice` and for `fs_write` with `hex`.

| Case | `expect_hash` |
|---|---|
| The target exists | Required. Omitting it is `E_HASH_REQUIRED`. `context` includes the current hash and size |
| The target does not exist and this call creates it (`offset` is `"start"`, `"end"`, or `0`, and `delete_bytes` is 0) | Optional. Treated as `"absent"` |
| A log that cannot be hashed stably | Explicit `force: true`. The response includes `forced: true` |

```json
{ "code": "E_HASH_REQUIRED", "context": { "path": "...", "exists": true, "hash": "a3f1c7", "size": 15234 } }
```

### 5.6 Rules

1. A newline is never added. Write `0a` or `0d0a` if that is what you want.
2. The file is not edited in place. The server reads it, splices, writes a temp file, fsyncs, and renames.
3. An `offset` outside the file is `E_RANGE`. `context` includes `total_size`.
4. The response includes `size_before`, `size_after`, `hash_before`, `hash_after`, and `verified`.
5. A missing file is created only when `offset` is `"start"`, `"end"`, or `0` and `delete_bytes` is 0. Otherwise `E_NOT_FOUND`.
6. A file over 8 MB is `E_TOO_LARGE`.

### 5.7 Common shapes

| Goal | Arguments |
|---|---|
| Append a CRLF line | `offset: "end", insert: "another line\r\n"` |
| Append an LF line | `offset: "end", insert: "another line\n"` |
| Insert a BOM at the start | `offset: "start", insert_hex: "efbbbf"` |
| Replace four bytes | `offset: 8, delete_bytes: 4, insert_hex: "..."` |
| Delete a span | `offset: 1234, delete_bytes: 56` |

---

## 6. File error codes

| Code | Meaning | What to do |
|---|---|---|
| `E_INVALID_ARG` | Bad arguments: missing, wrong type, conflicting fields, odd-length hex, or base64 | Fix the arguments |
| `E_NOT_FOUND` | Path does not exist | Check the path |
| `E_IS_DIR` | The target is a directory | Check the path |
| `E_ACCESS` | Permission denied, or the file is busy and cannot be replaced | Wait, or use another path |
| `E_PATH` | The path is illegal | Change the path |
| `E_HASH_MISMATCH` | `expect_hash` does not match | Read again, look at the difference, then decide |
| `E_HASH_REQUIRED` | An existing file was passed to `fs_splice` or hex `fs_write` without `expect_hash` and without `force` | Take the hash from `fs_stat`, or pass `force: true` |
| `E_EXISTS` | `expect_hash` is `"absent"` but the file exists | Read it again |
| `E_NO_MATCH` | `old_text` was not found | Read the file and edit the text that is there |
| `E_AMBIGUOUS` | `old_text` occurs more times than `count` | Lengthen `old_text` until it is unique |
| `E_OVERLAP` | Edit ranges overlap | Split the call |
| `E_RANGE` | The byte range is outside the file | Read `total_size` |
| `E_NOT_TEXT` | Text was required and the contents are binary, or the reverse | Use the other tool |
| `E_TOO_LARGE` | Over the per-call or per-file limit | Split the work, or use a script |
| `E_ENCODING_UNSURE` | Confidence is `fallback` and `encoding` was not set | Pass `encoding` |
| `E_ENCODING_ROUNDTRIP` | The charset cannot round-trip the file | Use another `encoding` |
| `E_ENCODING_UNREPRESENTABLE` | `new_text` contains a character the charset cannot store | Change the charset or the text |
| `E_VERIFY_FAILED` | The read-back does not match | Stop |
| `E_IO` | Another I/O failure. `message` includes the system text | Read `message` |

Codes are only added. They are not renamed.

---

## 7. Not provided

| Not provided | Why |
|---|---|
| A lease | `expect_hash` already stops a stale overwrite. A direct shell write is still unprotected |
| A `purpose` parameter | Writes do not carry a business label |
| `fs_append` | Use `fs_splice` |
| `fs_delete` | Use the shell |
| base64 | Hex only |
| A choice of hash algorithm or length | sha256, first 6 hex digits |
| A `hash_max_bytes` parameter | Fixed at 64 MB |
| A file-handle session | Each call stands alone |
| Directory listing, search, move, or permissions | Use the shell |
| Regular-expression replace | That belongs in a script |
| `normalize_eol` | Newlines must match exactly |
| `count: "all"` | Only a number is allowed |
| Turning off `verified` | That is the definition of success |

---

## 8. Behavior

1. Reads are by byte. The file is not loaded as a UTF-8 string and then sliced.
2. `offset`, `length`, and `delete_bytes` are bytes, not characters, and not JavaScript `string.length`.
3. A write is a temp file in the same directory, `sync`, then `rename`. On Windows a busy target is retried up to 5 times. If it still fails, the error is `E_ACCESS` and the old bytes stay.
4. Hashes of files over 64 MB are computed as a stream.
5. The post-write check compares the short hash of the whole file, not of the edited span.

## Execution

Output is one text stream. It is not split into parts and it is not labeled. Cursor and length use Unicode code points. A live job is only `running` or `standing_by`. `exec` and `job_send` wait 10 seconds by default. When the wait ends, the job is not stopped. File tools are specified above.

## 0. Common rules

### 0.1 What one run looks like

Most runs are one shot: a command, a result a few seconds later, done. One `exec` returns the screen you would have seen in a shell. The default wait is 10 seconds, so a short command does not need a second call.

If it is still running at 10 seconds, `exec` returns the output it already has and leaves the job running. Keep reading with `job_read` until it exits or you stop it. Short and long commands use the same tool. The wait cap is the same. The only difference is whether the job is still running when the call returns.

Two questions cover the rest:

1. How much text one call returns, and when it returns (§1.6 and §4).
2. How long a job lives, and who can see it (§0.3 and §2).

### 0.2 The five execution tools

| Tool | In one line |
|---|---|
| `exec` | Start a job and wait until it leaves `running` or `timeout` elapses (default 10 seconds). The response includes one read of the last 4096 code points |
| `job_read` | Read output by code-point cursor. `wait_ms` greater than 0 waits until the job leaves `running`. There is no `job_wait` |
| `job_send` | Write stdin. The response includes one read. The default wait is 10 seconds |
| `job_list` | List what is running |
| `job_kill` | Stop the job, including its process tree |

The `exec` result is a `job_read` result. Same shape, same fields. `exec` places `cursor` at the tail and sets the wait to `timeout`.

There is no `job_wait`. Waiting is `job_read` with `wait_ms`. The read already returns text and status.

There is no separate "move to background" action. The job is in the background from the first millisecond. `exec` is a `job_read` that waits. If the wait ends first, the job is not killed, not exited, and not restarted.

### 0.3 No caller identity. HTTP tables follow the session

The server does not record who the caller is. There is no `owner`. `tags` are labels the caller attaches. The server does not validate them.

- stdio: one table for the process.
- HTTP: a valid `Mcp-Session-Id` is the table key. Requests without the header share the anonymous table. `initialize` without the header writes a new `Mcp-Session-Id` on the response. That `initialize` itself still uses the anonymous table. Later requests send the value from the response.
- A `job_id` from another table is `E_NOT_FOUND`. The error does not say whether it exists.
- Files, file locks, and `max_jobs` (64) are process-wide. Jobs found lost after a restart go into the anonymous table only.

### 0.4 `mode` is required

`mode` has no default.

| `mode` | Required fields | Payload |
|---|---|---|
| `"argv"` | `program` and `args[]` | A program name and an argument array |
| `"shell"` | `script` and `interpreter` | A script for that interpreter |

- A missing `mode` is `E_INVALID_ARG`.
- `mode: "argv"` with `script`, or the reverse, is `E_INVALID_ARG`.
- An `interpreter` that is not supported is `E_INVALID_ARG`. `hint` lists what this machine can run.

The two modes have different quoting rules. The caller has to say which one it is using.

### 0.5 Platform differences are reported

What the platform cannot do is written in `enforcement`. The matrix is in §7.

### 0.6 Response envelope

Same as the file tools: `{ ok, data }` or `{ ok, error: { code, message, hint, context } }`.

### 0.7 Working directory and encoding

- `cwd` is its own field. Do not prefix the command with `cd`.
- A missing `cwd` is `E_NOT_FOUND`. There is no silent fallback.
- Output decoding follows §6.3. A decode failure never fails the call. The response includes `encoding_used`.
- `env` merges by default. `env_mode: "replace"` replaces the environment.

---

## 1. `exec`

### 1.1 argv

```json
{
  "mode": "argv",
  "program": "npm",
  "args": ["run", "build"],
  "name": "build",
  "cwd": "D:\\workspace\\finch-shell-mcp",
  "env": { "NODE_ENV": "production" },
  "timeout": 10000,
  "tags": { "project": "demo", "stage": "build" }
}
```

### 1.2 shell

```json
{
  "mode": "shell",
  "script": "Get-ChildItem -Recurse -Filter *.ts | Measure-Object",
  "interpreter": "pwsh",
  "name": "count-ts-files",
  "cwd": "D:\\workspace\\finch-shell-mcp",
  "timeout": 10000
}
```

### 1.3 Fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `mode` | yes | — | `"argv"` or `"shell"` |
| `program` | argv | — | A program name or path. A bare name is looked up on PATH, not in the current directory |
| `args` | argv | `[]` | Argument array. Nothing is joined or escaped |
| `script` | shell | — | The whole script |
| `interpreter` | shell | — | See §1.4 |
| `name` | no | `null` | A label for people. It does not have to be unique |
| `cwd` | no | the server process cwd | Must exist |
| `env` | no | `{}` | Merge or override, not a full replacement |
| `env_mode` | no | `"merge"` | `"merge"` or `"replace"` |
| `timeout` | no | `10000` | How long this call may block, in milliseconds. Maximum 60000. The job is not killed |
| `ttl_ms` | no | `1800000` | How long the job may live. Default 30 minutes. Maximum 86400000 (24 hours). Expiry is what kills it |
| `tags` | no | `{}` | See §3 |
| `stdin` | no | `null` | Initial input |
| `close_stdin` | no | `false` | Close stdin immediately |
| `mem_limit_mb` | no | `null` | Working-set cap for the process tree |
| `cpu_limit_ms` | no | `null` | Not measured. Setting it is `E_INVALID_ARG` |
| `grace_ms` | no | `3000` | How long to wait before a forced stop |

`timeout` above 60000 is `E_INVALID_ARG`. To wait longer, call `job_read` again with `wait_ms`.

`timeout` is how long this call waits. `ttl_ms` is how long the job may live. Passing `timeout` returns from this call and leaves the job running. When `ttl_ms` expires, `status` is `timeout` and the call is still `ok: true`, not `E_TIMEOUT`. Exceeding `mem_limit_mb` sets `status` to `killed` and the call still succeeds. A long job should set a larger `ttl_ms`.

### 1.4 Interpreters

| Platform | Values |
|---|---|
| Windows | `cmd`, `powershell` (5.1), `pwsh` (7+), `bash` when Git Bash is installed |
| Linux | `sh`, `bash`, `zsh`, `fish`, `dash` |
| macOS | `sh`, `bash`, `zsh`, `fish` |
| Everywhere | `python`, `python3`, `node` |

The list is what startup actually found, not a fixed list. A name that is not on it is `E_INVALID_ARG`, and `hint` lists the ones that are. How the interpreter is launched is an implementation detail. The script text must not be damaged by the launch, and the interpreter's own progress or serialization wrapper must not appear in `text`.

### 1.5 Response

An `exec` response is a `job_read` response. `exec` reads the last 4096 code points. Its wait is `timeout` from the same request, default 10 seconds.

```json
{
  "job_id": "j_7f3a19",
  "name": "build",
  "status": "finished",
  "exit_code": 0,
  "signal": null,
  "text": "building...\nwarning: unused variable 'x'\ndone\n",
  "cursor_start": 0,
  "cursor": 51,
  "total_chars": 51,
  "truncated": false,
  "dropped_chars": 0,
  "encoding_used": "utf-8",
  "lossy": false,
  "duration_ms": 8421,
  "peak_rss_mb": 412.7,
  "children": 0,
  "log_path": "...\\j_7f3a19.log",
  "enforcement": { "mem": "kernel", "tree_kill": "kernel" }
}
```

There is one `text` and a few fields that describe it. No segments, no labels, no array of records.

Live statuses are `running` (producing output) and `standing_by` (alive and quiet). Terminal statuses are `finished`, `failed`, `timeout`, and `killed`. `lost` appears only after the server restarts.

### 1.6 What you see when `timeout` elapses

`timeout` does not kill the job. It ends this wait.

| Where the job is | `status` | Still alive | Next step |
|---|---|---|---|
| Exited | `finished` or `failed` | no | Use the result |
| Quiet | `standing_by` | yes | Read `prompt_hint`. To send input, use `job_send` |
| Still producing output | `running` | yes | Continue with `job_read` |

- `killed` and `timeout` do not come from this wait. They come from `job_kill` and from `ttl`.
- A quiet command returns early. An interactive prompt is classified as `standing_by` after 1.5 seconds. See §2.3.
- A build that keeps printing stays `running`. `exec` waits 10 seconds and returns what it has.

### 1.7 Rules

1. `running` and `standing_by` are not errors. `ok` is true.
2. A non-zero `exit_code` is not a tool error. `ok` is true and `status` is `"failed"`. `ok` means the call ran. It does not mean the command succeeded.
3. stdout and stderr are one `text`, in the order they were written. No markers and no segments.
4. One read returns at most 16384 code points. `exec` defaults to the last 4096.
5. `job_id` is the identifier. `name` is a label.
6. A wait does not kill the job. Use `ttl_ms` or `job_kill` to stop it.

---

## 2. Identity, name, and lifetime

### 2.1 Two fields

| Field | Who sets it | Unique | Use |
|---|---|---|---|
| `job_id` | the server | yes | Every API uses this |
| `name` | the caller, optional | no | A label. It is not part of the log file name |

`name` may be repeated. Ten jobs can all be named `build`. They are ten `job_id` values.

### 2.2 States

```
                 +-> finished (exit 0)
                 +-> failed (non-zero exit, or the process failed to start)
created -> running +-> timeout (killed because ttl elapsed)
                 +-> killed (job_kill, or over the memory limit)
                 +-> quiet for 1500 ms -> standing_by
                                         |
                     new output ---------+-> running
```

- A live job has two states. `running` means output is still arriving. `standing_by` means it has not ended and it is not producing output.
- `standing_by` does not distinguish "waiting for input" from "a long-running server". The server does not guess. Whether input is accepted is `E_STDIN_CLOSED` from `job_send`.
- 1500 ms of quiet means a burst has ended. A shorter gap is the same burst.
- State does not flicker in the middle of a burst. It is updated on the 1500 ms boundary.
- After the job ends, status and text are kept for 10 minutes. Then `job_read` is `E_JOB_GONE`.
- On server restart, every non-terminal job is `lost`. `job_list` shows them. They are not described as still running.

### 2.3 How `standing_by` is decided

Both of these are true:

1. The process is alive.
2. At least 1500 ms have passed since the last output, or since start if there has been none.

Whether stdin is open is not part of the decision. `job_send` decides whether a write is accepted: not `standing_by` is `E_NOT_INTERACTIVE`, and a closed stdin is `E_STDIN_CLOSED`.

`prompt_hint` may be set from the last 200 characters (`> `, `$ `, `Password:`, `(y/n)`, `? `, or the Windows "press any key" prompt). It does not change status. Prompts are not used as the state, because a program can print `> ` without waiting.

### 2.4 Retention

- A live job is kept until it ends.
- A finished job stays in memory for 10 minutes. `job_read` and `job_list` with `include_finished` can see it.
- After that, `job_read` is `E_JOB_GONE`. `context.log_path` still points at the log.
- Finished log files are kept for 7 days and deleted by modification time, not by size. Logs in `jobs/active`, including ones marked `lost` after a restart, are not deleted automatically. Temp scripts are kept for 1 day.

### 2.5 Status is a snapshot

The caller polls with `job_read`. There is no callback. A caller may be a one-shot connection, so there is nobody to push to.

---

## 3. Tags

Tags filter a job table. They are not identity.

```json
{ "tags": { "project": "demo", "stage": "build" } }
```

- Keys are at most 32 characters. Values are at most 128. The allowed characters are `[A-Za-z0-9._:-]`.
- At most 16 pairs.
- No key is reserved.
- The server does not rewrite, validate beyond that shape, or fill in tags.

`tags` on start is optional and defaults to `{}`. `job_list({ tags: { project: "x" } })` is a subset match: every listed pair must match, and extra tags on the job do not exclude it. Omitting `tags` returns every job.

---

## 4. `job_read` and `job_send`

### 4.1 `job_read`

One text stream and one cursor. stdout and stderr are concatenated in the order they were written.

```json
{ "job_id": "j_7f3a1a", "cursor": 0, "max_chars": 16384, "wait_ms": 0 }
```

| Field | Default | Meaning |
|---|---|---|
| `cursor` | 0 | A code-point index. Positive counts from the start. Negative counts from the end. Out of range becomes 0 |
| `max_chars` | 16384 | Cap for this response. Maximum 16384 |
| `wait_ms` | 0 | Wait until the job leaves `running`, or until this elapses. Maximum 60000 |

```json
{
  "job_id": "j_7f3a1a",
  "status": "running",
  "text": "compiling...\nwarning: unused variable 'x'\n",
  "cursor_start": 0,
  "cursor": 42,
  "total_chars": 24000,
  "chars_returned": 42,
  "truncated": true,
  "eof": false,
  "dropped_chars": 0,
  "encoding_used": "utf-8",
  "lossy": false,
  "prompt_hint": null
}
```

| Field | Meaning |
|---|---|
| `text` | The text from this read |
| `cursor_start` | Where this read started. A negative request is reported as the resolved index |
| `cursor` | Where the next read should start. `text` does not repeat |
| `total_chars` | Code points produced so far |
| `chars_returned` | Code points in this response, equal to `cursor - cursor_start` |
| `truncated` | There is more after this cursor. This can be true together with `capped`: this page hit the cap, and more remains |
| `capped` | This response was limited by `max_chars`, or by the 4096-point exec tail. A tail read can have `truncated` false and `capped` true |
| `eof` | This read reached the current end. A running job may produce more later |
| `dropped_chars` | Code points that have left the memory ring. They are still in the log. `job_read` from 0 can still read them |
| `prompt_hint` | A prompt clue at the tail while the job is alive. Always null in a terminal state. It does not affect `status` |

The cursor unit is a Unicode code point, not a byte and not a UTF-16 code unit. One CJK character counts as 1. One emoji counts as 1. The server does not split a surrogate pair. `text` does not contain a lone surrogate. `chars_returned` is a code-point count. JavaScript `text.length` is larger than `chars_returned` when the text contains an emoji, because one emoji is two code units there.

| Goal | Call |
|---|---|
| Read from the start | `cursor: 0` |
| Continue | `cursor` from the previous response |
| Last 4096 code points | `cursor: -4096` |
| Wait for this burst to stop | `wait_ms: 10000` |
| Wait until it exits | `wait_ms: 60000`. The call returns when `status` is terminal |

`wait_ms` waits for a state change, not for new output. A job in `running` is expected to keep producing output inside each 1.5 second window, so waiting for "new output" would not end. The wait ends when the job is no longer `running`: it became quiet (`standing_by`) or it finished. If the wait elapses first, the response has the text so far and `status: "running"`. The job is unchanged.

The caller holds the cursor. If it is lost, read again from `cursor: 0`. The server does not remember where a caller left off.

### 4.2 `job_send`

```json
{ "job_id": "j_7f3a1a", "input": "y\n", "cursor": 5120, "close_after": false }
```

| Field | Default | Meaning |
|---|---|---|
| `input` | — | Text, encoded with the job charset. Mutually exclusive with `input_hex` |
| `input_hex` | — | Raw bytes |
| `cursor` | required | Where to start reading after the write. Omitting it is `E_INVALID_ARG` |
| `close_after` | `false` | Close stdin after the write |
| `wait_ms` | `10000` | How long to wait after the write. Maximum 60000 |

The cursor is required so the response does not repeat output the caller already has. After a write the job returns to `running` immediately. The 1500 ms quiet rule does not apply to that moment. Input does not get a newline added. Write `\n` if you want one.

The response has the same shape as `job_read`, plus `input_bytes` and `stdin_closed`.

---

## 5. `job_list` and `job_kill`

### 5.1 `job_list`

```json
{ "tags": { "project": "finch-shell-mcp" }, "include_finished": false, "limit": 50 }
```

```json
{
  "jobs": [
    {
      "job_id": "j_7f3a1a",
      "name": "dev-server",
      "status": "running",
      "pid": 18844,
      "command": "npm run dev",
      "cwd": "D:\\workspace\\finch-shell-mcp",
      "tags": { "project": "finch-shell-mcp", "stage": "dev" },
      "started_at": "2026-11-07T14:22:31.889Z",
      "expires_at": "2026-11-07T16:22:31.889Z",
      "elapsed_ms": 41233,
      "total_chars": 8123,
      "peak_rss_mb": 310.2,
      "children": 3,
      "log_path": "...",
      "last_output_at": "2026-11-07T14:23:10.221Z",
      "prompt_hint": null
    }
  ],
  "total": 1,
  "running_count": 1,
  "max_jobs": 64
}
```

`children` is the live descendant count. Windows `conhost.exe` is not counted. After a terminal state, `children` is 0. Survivors of a kill are `remaining_children` on the `job_kill` response, not a later sample. `elapsed_ms` stops at the end time. `command` keeps newlines from the script and is about 400 characters.

### 5.2 `job_kill`

```json
{ "job_id": "j_7f3a1a", "grace_ms": 3000 }
```

Stdin is closed first. The wait is capped at 5 seconds.

- Windows (`tree_kill: "walk"`): `taskkill /T /F` immediately, wait `grace_ms`, then run it again if anything remains. `escalated` is true because the first step is already a forced stop. A process born after the walk starts, or reparented after its parent exits, can be missed.
- POSIX (`tree_kill: "kernel"`): the child is started `detached`, in its own process group. The group gets `SIGTERM`, then `grace_ms`, then `SIGKILL` if anything remains. Each process that was in the tree before the signal is signaled too. `escalated` is true only when the second step runs. If the group signal fails, only that pid is signaled. A zombie is not a survivor.

Response: `{ killed: true, escalated: true, remaining_children: 0, exit_code: 137 }`. On POSIX, `escalated` can be false.

Calling it again on a finished job returns `{ killed: false, escalated: false, remaining_children: 0 }` plus the current `status`. That is not an error.

A partial stop is `E_KILL_INCOMPLETE`, with `context.remaining_children`. The check uses a fresh snapshot. `children` on a terminal job is 0. The count that matters is `remaining_children` on this response.

---

## 6. Output storage and encoding

### 6.1 Two layers

| Layer | Size | Use |
|---|---|---|
| Log file | unbounded, on disk | The full record. `log_path` is returned. Read it with `fs_read` when needed |
| Memory ring | 2,000,000 code points | A fast path for reads near the end. An earlier cursor reads the log, so the ring is not a limit on `job_read` |

The log is written from the first byte, not only after memory fills. `dropped_chars` counts code points that are no longer in the ring. A non-zero value does not mean the output cannot be read: `cursor: 0` still reads the earliest output from the log.

stdout and stderr are written to the same file in arrival order, with no markers. To keep stderr alone, redirect it in the command (`2>err.txt`).

### 6.2 Why the unit is a code point

`cursor`, `max_chars`, `total_chars`, and `chars_returned` use the same unit.

1. Bytes are decoded before the cursor is assigned, so the same bytes are not decoded twice.
2. The ring counts code points. Memory use is about 1 to 4 bytes per code point.
3. `dropped_chars` is a code-point count, not a byte count.

Because the cursor is assigned after decoding, it does not fall between the two halves of a surrogate pair or in the middle of a multibyte character.

### 6.3 Decode order

1. BOM.
2. Strict UTF-8 for the whole chunk.
3. UTF-16LE or UTF-16BE from the NUL pattern.
4. A platform hint: Windows `chcp` (936 is GBK, 65001 is UTF-8), or POSIX `LANG` / `LC_ALL`.
5. `jschardet`.
6. UTF-8 with U+FFFD replacement and `lossy: true`.

A decode failure never fails the call. The response includes `encoding_used` and `lossy`.

One job has one charset. The first chunk that can be classified sets `encoding_used`. Later bytes use that charset. A failed round trip sets `lossy` to true. There is no field for a code page that changed halfway through.

### 6.4 Environment set at start

| Target | What is set | Where |
|---|---|---|
| Python | `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, `PYTHONUNBUFFERED=1` | everywhere |
| Node and other programs | `FORCE_COLOR=0` | everywhere |
| General | `TERM=dumb`, `NO_COLOR=1` | everywhere |

The system code page, the registry, and the user environment are not changed. The variables apply only to the process this server starts. A value already present in the request `env` is kept.

---

## 7. What each platform actually does

The current implementation returns:

```json
{ "enforcement": { "mem": "monitor", "tree_kill": "walk", "cpu": "none" } }
```

On POSIX, `tree_kill` is `"kernel"`. The other two fields are the same.

| Capability | Behavior |
|---|---|
| Stop a process tree | Windows: `taskkill /T /F`, `walk`. POSIX: process-group `SIGTERM` then `SIGKILL`, `kernel` |
| Memory cap | The working set of the tree is sampled about once a second. Over `mem_limit_mb`, the job is stopped the same way as `job_kill` and `status` is `killed`. `mem` is `monitor`, not a kernel quota |
| CPU | Not measured. `cpu_limit_ms` is `E_INVALID_ARG`. `cpu` is `none` |
| Child count | Windows uses the CIM process table. POSIX reads `/proc`. `conhost.exe` is not included in `children`. After a terminal state, `children` is 0 |
| Output encoding | §6.3. Unreadable bytes become the replacement character and `lossy` is true. The call does not fail |

---

## 8. Two different interruptions

| Case | What happens | What to do |
|---|---|---|
| The caller disconnects | The tool call is cancelled, or the connection drops | The job keeps running. Come back with `job_list` and `job_read` |
| The child goes quiet | `status` is `standing_by` | Read `prompt_hint`. To send input, use `job_send` |

A dropped connection is not the same as a program waiting for input.

```
1. job_list({ tags: {...} })
2. job_read({ job_id, cursor: -4096 })
3. If standing_by, job_send({ job_id, input: "...\n", cursor })
4. Keep the returned cursor and call job_read until status is terminal or truncated is false
```

A pipe cannot deliver process-level Ctrl-C or Ctrl-Z, a password prompt that reads the terminal, a progress bar that checks for a tty, or a `python -i` prompt. Passing `tty` is `E_TTY_UNAVAILABLE`.

---

## 9. tty

There is no terminal. stdin, stdout, and stderr are pipes. Passing `tty` as `true` or `false` is `E_TTY_UNAVAILABLE`. Any other unknown field is `E_INVALID_ARG`. Neither is ignored.

---

## 10. Execution error codes

| Code | Meaning | What to do |
|---|---|---|
| `E_INVALID_ARG` | Bad arguments: missing `mode`, mode does not match the payload, unknown interpreter, over a limit, unknown field, or `job_send` without `cursor` | Fix the arguments |
| `E_NOT_FOUND` | Unknown `job_id`, missing `cwd`, or `program` was not found | Check it |
| `E_ACCESS` | Permission denied, or the program refused to run | Try another way |
| `E_SPAWN_FAILED` | The process did not start. `message` includes the system text | Read `message` |
| `E_TOO_MANY_JOBS` | The 64-job cap was hit | Stop or wait for some |
| `E_JOB_GONE` | The 10-minute retention window has passed. `context` includes `log_path` | Read the log file |
| `E_STDIN_CLOSED` | stdin is already closed | The job will not take input |
| `E_NOT_INTERACTIVE` | `job_send` while the job is not `standing_by` | `job_read` until it is quiet |
| `E_KILL_INCOMPLETE` | Some children are still alive. `context.remaining_children` is the count | Retry, or stop them another way |
| `E_TTY_UNAVAILABLE` | The request included `tty` | Remove `tty`. For a password, use a key file or the program's own non-interactive flag |
| `E_IO` | Another system error | Read `message` |

`E_MEM_LIMIT` and `E_TIMEOUT` are names in the error set. A memory cap or a ttl expiry does not return them. Those end the job with `ok: true` and a terminal `status`.

Codes are only added. They are not renamed.

---

## 11. Guarantees

1. A job belongs to the server process, not to one request. While the process is up, the job is up. On HTTP only the same session table can see it.
2. A job has `job_id`, `name`, `tags`, `started_at`, `expires_at`, and `log_path`.
3. `ok: true` means the call succeeded. `status` and `exit_code` are the command result.
4. The ring is not the whole transcript. Code points that left it are `dropped_chars`. They remain in the log, and `job_read` from 0 can read them.
5. A partial kill is `E_KILL_INCOMPLETE`.
6. A tty is not available.
7. `enforcement` says `kernel`, `monitor`, or `none` for what is actually enforced.
8. The server does not know who the caller is. There is no `owner`.
9. A single wait is at most 60 seconds. When it ends, `status` is `running`, `standing_by`, or terminal. A wait does not kill the job.
10. One call returns one text stream.
11. The cursor unit is always a Unicode code point. Returned text does not start or end with a lone surrogate.

---

## 12. Invariants

- Output is one text stream. stdout and stderr are joined in arrival order.
- `cursor`, `max_chars`, `total_chars`, and `chars_returned` are Unicode code points. Returned text does not start or end with a lone surrogate.
- An `exec` response has the same shape as one `job_read`, and it reads the last 4096 code points by default.
- There is no `job_wait`. `job_read` `wait_ms` waits for a state change.
- `job_send` requires `cursor`.
- One read returns at most 16384 code points.
- Passing `tty` is `E_TTY_UNAVAILABLE`. Any other unknown field is `E_INVALID_ARG`.
- There is no `owner`. `max_jobs` is 64 for the process, with no queue.
- `name` may repeat. `job_id` is unique.
- `mode` is required. `timeout` and `job_send` `wait_ms` default to 10 seconds and cap at 60 seconds. `ttl_ms` defaults to 30 minutes and caps at 24 hours.
- A live job is `running` or `standing_by`. 1500 ms without new output enters `standing_by`.
- `job_send` accepts only `standing_by`.
- `timeout` does not end a job. A job ends when the process exits, when `ttl_ms` elapses, or when `job_kill` runs.
- A finished job stays in memory for 10 minutes. Finished logs are kept for 7 days. Lost logs in `active` are not deleted automatically.
- `enforcement` matches §7.
- There is no audit log. A write is identified by `hash_before` and `hash_after`. A run is identified by `job_id` and `log_path`.
