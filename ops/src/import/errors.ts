// The import tool's own refusals (card P4-02). A refusal is a problem with what the
// tool was handed (an export that does not match its manifest, a database that is not
// ready), not a bug: its message is written for the person running the command, says
// what to do, and never quotes a cell. Anything else that is thrown is a surprise.

export class ImportRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRefused";
  }
}
