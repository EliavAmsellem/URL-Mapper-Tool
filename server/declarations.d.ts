declare module "node-xlrd" {
  interface XlsCell {
    (rowx: number, colx: number): unknown;
    getValue: (rowx: number, colx: number) => unknown;
    getType: (rowx: number, colx: number) => number;
    getText: (rowx: number, colx: number) => string;
  }

  interface XlsRow {
    getValues: (rowx: number) => unknown[];
    getCount: (rowx: number) => number;
    count: number;
  }

  interface XlsSheet {
    name: string;
    nrows: number;
    ncols: number;
    cell: XlsCell;
    row: XlsRow;
  }

  interface XlsSheetAccessor {
    count: number;
    byIndex: (index: number) => XlsSheet;
    byName: (name: string) => XlsSheet;
    names: string[];
  }

  interface XlsBook {
    sheet: XlsSheetAccessor;
    biffVersion: number;
    encoding: string;
  }

  function open(
    fileName: string,
    callback: (err: Error | null, book: XlsBook) => void
  ): void;
  function open(
    fileName: string,
    options: Record<string, unknown>,
    callback: (err: Error | null, book: XlsBook) => void
  ): void;
}
