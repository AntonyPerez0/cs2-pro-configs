import { nativeCommands, exportOverrides } from '../settings/native.js';
import { commandLine } from '../settings/command-line.js';
import { scope, unsupported } from './renderer.js';

/** Every `nativeCommands` override the export uses: the export options (style, a hand-chosen outline mode) merged
 * with the report's edge-case overrides (colour, outline mode), which win. Reports store it as `exportedOverrides`. */
export const mergedExportOverrides = report =>
  ({ ...exportOverrides(report.settings, scope(report.options)), ...report.exportOverrides });

/** The export boundary validates native values; the output is one `;`-separated console line without comments.
 * `include` (see `nativeCommands`) leaves out optional line groups; null exports every group. */
export function exportQuantCFG(report, include = null) {
  const s = report.settings, o = scope(report.options), blockers = unsupported(s);
  if (blockers.length || report.blockers?.length) throw new Error([...blockers, ...(report.blockers ?? [])].join(' '));
  return commandLine(nativeCommands(s, report.chosen.native, mergedExportOverrides(report), include));
}
