import { readFileSync, statSync } from 'node:fs'
import { dirname, relative, sep } from 'node:path'
import type { HtmlReport } from './model.js'

export interface EmbedOptions {
  /** The file the page will be written to. Relative links are resolved from it. */
  target: string
  /** Largest single artifact to carry inside the page, in bytes. */
  perFile: number
  /** How many bytes of artifacts the page may carry in total. */
  budget: number
}

export interface EmbedReport {
  /** Artifacts carried inside the page. */
  inlined: number
  /** Artifacts left as a relative link, because they were too big or the budget ran out. */
  linked: number
  /** Artifacts the run named and that were not on disk to read. */
  missing: number
  bytes: number
}

/**
 * Gives every artifact an `href` the page can use, and says what it did.
 *
 * The report is one file on purpose, and an artifact is the one thing that
 * makes that hard: a screenshot is half a megabyte and a run has thirty of
 * them. So the rule is a budget rather than an absolute — small things ride
 * along and the page stays a page you can mail, large ones stay links back
 * into `reports/<runId>/artifacts/`, which is where they already are and where
 * `upload-artifact` is already sending them.
 *
 * A link relative to the HTML file rather than an absolute path: an absolute
 * one is right on the machine that produced the report and wrong on every
 * machine that downloads it, which is all of them.
 */
export function embedArtifacts(report: HtmlReport, options: EmbedOptions): EmbedReport {
  const base = dirname(options.target)
  const summary: EmbedReport = { inlined: 0, linked: 0, missing: 0, bytes: 0 }

  for (const test of report.tests) {
    for (const artifact of test.artifacts) {
      if (!artifact.path) {
        // The run kept the bytes in memory and wrote nothing, so the event
        // carries a count and no content. Nothing to point at, and a link to
        // nothing would be worse than the absence.
        summary.missing++
        continue
      }

      let size: number
      try {
        size = statSync(artifact.path).size
      } catch {
        summary.missing++
        continue
      }

      const room = summary.bytes + size <= options.budget
      if (size <= options.perFile && room) {
        try {
          const body = readFileSync(artifact.path)
          artifact.href = `data:${artifact.contentType};base64,${body.toString('base64')}`
          summary.inlined++
          summary.bytes += size
          continue
        } catch {
          summary.missing++
          continue
        }
      }

      artifact.href = href(base, artifact.path)
      summary.linked++
    }
  }

  return summary
}

/**
 * A relative URL, with separators the browser understands.
 *
 * `path.relative` answers in the platform's separator, and on Windows that is
 * a backslash — which a browser reads as part of the file name rather than as
 * a directory boundary, so the link resolves to nothing and does it quietly.
 */
function href(from: string, to: string): string {
  return relative(from, to).split(sep).map(encodeURIComponent).join('/')
}
