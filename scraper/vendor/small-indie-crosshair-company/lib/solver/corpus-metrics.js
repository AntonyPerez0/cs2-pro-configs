/** Descriptive model-agreement statistics. Repeated players do not create independent geometry groups. */
export function summarizeConversions(rows) {
  const methods = {};
  for (const method of ['current', 'plain']) {
    const visible = rows.filter(row => row[method].iou !== null), groups = new Map();
    for (const row of visible) {
      const group = groups.get(row.signature) ?? [];
      group.push(row[method].alignedIou);
      groups.set(row.signature, group);
    }
    const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    methods[method] = { cases: rows.length, visible: visible.length, empty: rows.length - visible.length,
      exact: rows.filter(row => row[method].status === 'exact').length,
      shifted: rows.filter(row => row[method].status === 'shifted').length,
      approximate: rows.filter(row => row[method].status === 'approximate').length,
      meanIou: mean(visible.map(row => row[method].iou)),
      meanAlignedIou: mean(visible.map(row => row[method].alignedIou)),
      geometryMacroAlignedIou: mean([...groups.values()].map(mean)), geometryGroups: groups.size };
  }
  const comparable = rows.filter(row => row.current.alignedIou !== null && row.plain.alignedIou !== null);
  return { ...methods, improved: comparable.filter(row => row.current.alignedIou > row.plain.alignedIou + 1e-9).length,
    regressed: comparable.filter(row => row.current.alignedIou < row.plain.alignedIou - 1e-9).length,
    aimImproved: comparable.filter(row => row.current.aimIou != null && row.plain.aimIou != null &&
      row.current.aimIou > row.plain.aimIou + 1e-9).length,
    aimTradeoffs: comparable.filter(row => row.current.aimIou != null && row.plain.aimIou != null &&
      row.current.aimIou > row.plain.aimIou + 1e-9 &&
      row.current.alignedIou < row.plain.alignedIou - 1e-9).length };
}
