import { SQLiteConnection } from "../storage/SQLiteConnection.js";

export class SchemaMigrator {
  constructor(private readonly connection: SQLiteConnection) {}

  migrate(): void {
    this.connection.migrate();
  }
}
