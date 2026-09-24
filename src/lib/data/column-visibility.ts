/**
 * Dynamic column/group visibility.
 *
 * A column is hidden only when none of the currently displayed rows has valid
 * data for it. A legitimate numeric zero is valid data; null/undefined is not.
 * Recompute after filtering, with the rows actually displayed.
 */
export function hasValidValue(value: unknown): boolean {
  return typeof value === "number" ? Number.isFinite(value) : value !== null && value !== undefined && value !== "";
}

export function visibleColumns<Row, Column extends { key: keyof Row; alwaysVisible?: boolean }>(columns: Column[], rows: Row[]): { visible: Column[]; hidden: Column[] } {
  const visible: Column[] = [];
  const hidden: Column[] = [];
  for (const column of columns) {
    if (column.alwaysVisible || rows.some((row) => hasValidValue(row[column.key]))) visible.push(column);
    else hidden.push(column);
  }
  return { visible, hidden };
}
