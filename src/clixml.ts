// Windows PowerShell 5.1 writes progress and error records as CLIXML on a pipe.
// The banner and <Objs> blocks are removed. Text between them is kept.
export class ClixmlGate {
  private rest = ''
  private saw = false

  push(text: string, final = false): string {
    let src = this.rest + text
    this.rest = ''
    let emit = ''
    while (src.length) {
      const banner = src.indexOf('#< CLIXML')
      const objs = this.saw ? src.indexOf('<Objs') : -1
      if (banner < 0 && objs < 0) {
        const marks = this.saw ? ['#< CLIXML', '<Objs'] : ['#< CLIXML']
        const partial = final ? 0 : markerSuffix(src, marks)
        if (partial > 0) {
          emit += src.slice(0, -partial)
          this.rest = src.slice(-partial)
        } else if (final && this.saw) {
          const tail = markerSuffix(src, ['#< CLIXML', '<Objs'])
          emit += src.slice(0, src.length - tail)
        } else {
          emit += src
        }
        break
      }
      const at = banner < 0 ? objs : objs < 0 ? banner : Math.min(banner, objs)
      emit += src.slice(0, at)
      src = src.slice(at)
      if (src.startsWith('#< CLIXML')) {
        this.saw = true
        const nl = src.indexOf('\n')
        if (nl < 0) {
          if (!final) this.rest = src
          break
        }
        src = src.slice(nl + 1)
        continue
      }
      const end = src.indexOf('</Objs>')
      if (end < 0) {
        if (!final) this.rest = src
        break
      }
      src = src.slice(end + '</Objs>'.length)
    }
    return emit
  }
}

function markerSuffix(src: string, marks: string[]): number {
  let keep = 0
  for (const mark of marks) {
    const max = Math.min(mark.length - 1, src.length)
    for (let size = max; size > 0; size--) {
      if (mark.startsWith(src.slice(-size))) keep = Math.max(keep, size)
    }
  }
  return keep
}
