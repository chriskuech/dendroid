use std::fs;

use dendroid_core::native::open_native_sql;
use pollster::block_on;
use serde_json::json;

fn tmp_workspace(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("dendroid-test-{name}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn create_list_and_delete_a_database() {
    let root = tmp_workspace("sqldb-crud");
    let mut sql = block_on(open_native_sql(&root, "session-a")).unwrap();

    assert!(sql.list_databases().is_empty());

    let id = block_on(sql.create_database("My Notes DB")).unwrap();
    let dbs = sql.list_databases();
    assert_eq!(dbs.len(), 1);
    assert_eq!(dbs[0].id, id);
    assert_eq!(dbs[0].name, "My Notes DB");

    block_on(sql.delete_database(&id)).unwrap();
    assert!(sql.list_databases().is_empty());
}

#[test]
fn exec_creates_a_table_and_rows_are_queryable() {
    let root = tmp_workspace("sqldb-exec");
    let mut sql = block_on(open_native_sql(&root, "session-a")).unwrap();
    let id = block_on(sql.create_database("Tasks")).unwrap();

    block_on(sql.exec(&id, "CREATE TABLE todos (title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)", vec![], false)).unwrap();
    block_on(sql.exec(&id, "INSERT INTO todos (title, done) VALUES (?1, ?2)", vec![json!("Write tests"), json!(0)], false)).unwrap();
    block_on(sql.exec(&id, "INSERT INTO todos (title, done) VALUES (?1, ?2)", vec![json!("Ship it"), json!(1)], false)).unwrap();

    let tables = sql.list_tables(&id).unwrap();
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0].name, "todos");
    assert_eq!(tables[0].columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["title", "done"]);

    let rows = sql.table_rows(&id, "todos", 10, 0, None, false).unwrap();
    assert_eq!(rows.total_rows, 2);
    assert_eq!(rows.rows.len(), 2);
    assert_eq!(rows.rows[0].values, vec![json!("Write tests"), json!(0)]);
    assert_eq!(rows.rows[1].values, vec![json!("Ship it"), json!(1)]);

    // Update and delete both go through the same `exec` path, addressed by
    // the `rowid` `table_rows` handed back.
    let target_rowid = rows.rows[0].rowid;
    block_on(sql.exec(&id, "UPDATE todos SET done = 1 WHERE rowid = ?1", vec![json!(target_rowid)], false)).unwrap();
    let after_update = sql.table_rows(&id, "todos", 10, 0, None, false).unwrap();
    assert_eq!(after_update.rows[0].values, vec![json!("Write tests"), json!(1)]);

    block_on(sql.exec(&id, "DELETE FROM todos WHERE rowid = ?1", vec![json!(target_rowid)], false)).unwrap();
    let after_delete = sql.table_rows(&id, "todos", 10, 0, None, false).unwrap();
    assert_eq!(after_delete.total_rows, 1);
}

#[test]
fn table_rows_can_be_sorted_by_a_real_column_in_either_direction() {
    let root = tmp_workspace("sqldb-sort");
    let mut sql = block_on(open_native_sql(&root, "session-a")).unwrap();
    let id = block_on(sql.create_database("Tasks")).unwrap();

    block_on(sql.exec(&id, "CREATE TABLE todos (title TEXT NOT NULL)", vec![], false)).unwrap();
    block_on(sql.exec(&id, "INSERT INTO todos (title) VALUES ('Charlie')", vec![], false)).unwrap();
    block_on(sql.exec(&id, "INSERT INTO todos (title) VALUES ('Alice')", vec![], false)).unwrap();
    block_on(sql.exec(&id, "INSERT INTO todos (title) VALUES ('Bob')", vec![], false)).unwrap();

    let asc = sql.table_rows(&id, "todos", 10, 0, Some("title"), false).unwrap();
    assert_eq!(asc.rows.iter().map(|r| r.values[0].clone()).collect::<Vec<_>>(), vec![json!("Alice"), json!("Bob"), json!("Charlie")]);

    let desc = sql.table_rows(&id, "todos", 10, 0, Some("title"), true).unwrap();
    assert_eq!(desc.rows.iter().map(|r| r.values[0].clone()).collect::<Vec<_>>(), vec![json!("Charlie"), json!("Bob"), json!("Alice")]);

    // An unknown column name is rejected rather than spliced into the SQL
    // text — see `table_rows`'s doc comment.
    assert!(sql.table_rows(&id, "todos", 10, 0, Some("nope; DROP TABLE todos"), false).is_err());
}

#[test]
fn query_runs_a_read_only_statement_without_ledgering_it() {
    let root = tmp_workspace("sqldb-query");
    let mut sql = block_on(open_native_sql(&root, "session-a")).unwrap();
    let id = block_on(sql.create_database("Tasks")).unwrap();
    block_on(sql.exec(&id, "CREATE TABLE todos (title TEXT NOT NULL)", vec![], false)).unwrap();
    block_on(sql.exec(&id, "INSERT INTO todos (title) VALUES ('Write tests')", vec![], false)).unwrap();

    let result = sql.query(&id, "SELECT title, length(title) AS len FROM todos WHERE title LIKE 'Write%'").unwrap();
    assert_eq!(result.columns, vec!["title", "len"]);
    assert_eq!(result.rows, vec![vec![json!("Write tests"), json!(11)]]);

    // A mutating statement is rejected — it must go through `exec` so it's
    // ledgered, not run directly here.
    let write_result = sql.query(&id, "DELETE FROM todos");
    assert!(write_result.is_err());
    assert_eq!(sql.table_rows(&id, "todos", 10, 0, None, false).unwrap().total_rows, 1, "the rejected DELETE must not have run");
}

#[test]
fn batch_exec_runs_a_multi_statement_script() {
    let root = tmp_workspace("sqldb-batch");
    let mut sql = block_on(open_native_sql(&root, "session-a")).unwrap();
    let id = block_on(sql.create_database("Batch")).unwrap();

    let script = "CREATE TABLE a (x INTEGER); INSERT INTO a (x) VALUES (1); INSERT INTO a (x) VALUES (2);";
    block_on(sql.exec(&id, script, vec![], true)).unwrap();

    let rows = sql.table_rows(&id, "a", 10, 0, None, false).unwrap();
    assert_eq!(rows.total_rows, 2);
}

#[test]
fn a_failed_statement_is_not_ledgered() {
    let root = tmp_workspace("sqldb-fail");
    let mut sql = block_on(open_native_sql(&root, "session-a")).unwrap();
    let id = block_on(sql.create_database("Broken")).unwrap();

    let result = block_on(sql.exec(&id, "NOT VALID SQL AT ALL", vec![], false));
    assert!(result.is_err());
    assert!(sql.history(&id).unwrap().is_empty(), "a failed statement must never reach history");

    // Reopening from disk must not see the failed statement either — it
    // never touched the ledger.
    let reopened = block_on(open_native_sql(&root, "session-b")).unwrap();
    assert!(reopened.history(&id).unwrap().is_empty());
}

#[test]
fn history_lists_most_recent_first_and_revert_truncates_the_timeline() {
    let root = tmp_workspace("sqldb-history");
    let mut sql = block_on(open_native_sql(&root, "session-a")).unwrap();
    let id = block_on(sql.create_database("History")).unwrap();

    block_on(sql.exec(&id, "CREATE TABLE t (v TEXT)", vec![], false)).unwrap();
    block_on(sql.exec(&id, "INSERT INTO t (v) VALUES ('one')", vec![], false)).unwrap();
    let checkpoint = sql.history(&id).unwrap();
    assert_eq!(checkpoint.len(), 2, "CREATE TABLE and INSERT are each their own entry");
    assert!(checkpoint[0].message.contains("INSERT"), "most recent first");
    let token = checkpoint[0].token.clone();

    block_on(sql.exec(&id, "INSERT INTO t (v) VALUES ('two')", vec![], false)).unwrap();
    assert_eq!(sql.table_rows(&id, "t", 10, 0, None, false).unwrap().total_rows, 2);

    block_on(sql.revert_to(&id, &token)).unwrap();
    let rows_after_revert = sql.table_rows(&id, "t", 10, 0, None, false).unwrap();
    assert_eq!(rows_after_revert.total_rows, 1, "revert should undo the second insert");
    assert_eq!(rows_after_revert.rows[0].values, vec![json!("one")]);

    // Nothing is erased from the log — a later exec still lands, extending
    // the (now-shorter) timeline exactly like a fresh forward edit would.
    block_on(sql.exec(&id, "INSERT INTO t (v) VALUES ('three')", vec![], false)).unwrap();
    let rows_after_new_insert = sql.table_rows(&id, "t", 10, 0, None, false).unwrap();
    assert_eq!(rows_after_new_insert.total_rows, 2);
    assert!(rows_after_new_insert.rows.iter().any(|r| r.values == vec![json!("three")]));
    assert!(!rows_after_new_insert.rows.iter().any(|r| r.values == vec![json!("two")]));

    // And it's durable: reopening from disk (fresh session, fresh process)
    // must reflect the reverted-then-extended state.
    let reopened = block_on(open_native_sql(&root, "session-b")).unwrap();
    let reopened_rows = reopened.table_rows(&id, "t", 10, 0, None, false).unwrap();
    assert_eq!(reopened_rows.total_rows, 2);
    assert!(!reopened_rows.rows.iter().any(|r| r.values == vec![json!("two")]));
}

#[test]
fn concurrent_sessions_merge_via_poll_external() {
    let root = tmp_workspace("sqldb-merge");
    let mut a = block_on(open_native_sql(&root, "session-a")).unwrap();
    let id = block_on(a.create_database("Shared")).unwrap();
    block_on(a.exec(&id, "CREATE TABLE t (v TEXT)", vec![], false)).unwrap();

    // `b` opens after `a`'s create+CREATE TABLE are already on disk, so it
    // sees them on open — same replay-from-ledger story as the markdown
    // tree's `open_native`.
    let mut b = block_on(open_native_sql(&root, "session-b")).unwrap();
    assert_eq!(b.list_databases().len(), 1);

    block_on(a.exec(&id, "INSERT INTO t (v) VALUES ('from-a')", vec![], false)).unwrap();
    block_on(b.exec(&id, "INSERT INTO t (v) VALUES ('from-b')", vec![], false)).unwrap();

    // Neither has seen the other's write yet.
    assert_eq!(a.table_rows(&id, "t", 10, 0, None, false).unwrap().total_rows, 1);
    assert_eq!(b.table_rows(&id, "t", 10, 0, None, false).unwrap().total_rows, 1);

    assert!(block_on(a.poll_external()).unwrap(), "a should observe b's ledger file");
    assert!(block_on(b.poll_external()).unwrap(), "b should observe a's ledger file");

    let a_values: Vec<_> = a.table_rows(&id, "t", 10, 0, None, false).unwrap().rows.into_iter().map(|r| r.values).collect();
    let b_values: Vec<_> = b.table_rows(&id, "t", 10, 0, None, false).unwrap().rows.into_iter().map(|r| r.values).collect();
    assert_eq!(a_values.len(), 2);
    assert!(a_values.contains(&vec![json!("from-a")]) && a_values.contains(&vec![json!("from-b")]));
    assert!(a_values.iter().all(|v| b_values.contains(v)));
}

#[test]
fn materialize_to_writes_one_plain_sqlite_file_per_database() {
    let root = tmp_workspace("sqldb-materialize");
    let mut sql = block_on(open_native_sql(&root, "session-a")).unwrap();
    let id = block_on(sql.create_database("My Notes DB")).unwrap();
    block_on(sql.exec(&id, "CREATE TABLE t (v TEXT)", vec![], false)).unwrap();
    block_on(sql.exec(&id, "INSERT INTO t (v) VALUES ('hello')", vec![], false)).unwrap();

    let out_dir = root.join("materialized-dbs");
    sql.materialize_to(&out_dir).unwrap();

    let entries: Vec<_> = fs::read_dir(&out_dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].starts_with("My_Notes_DB-"), "unexpected filename: {entries:?}");
    assert!(entries[0].ends_with(".sqlite"));

    // The written file is a real, standalone SQLite database, readable by
    // opening it directly — not just bytes that happen to look right.
    let materialized = rusqlite::Connection::open(out_dir.join(&entries[0])).unwrap();
    let value: String = materialized.query_row("SELECT v FROM t", [], |row| row.get(0)).unwrap();
    assert_eq!(value, "hello");

    // A second call (e.g. after a database was deleted) starts from a
    // clean directory rather than accumulating stale files.
    block_on(sql.delete_database(&id)).unwrap();
    sql.materialize_to(&out_dir).unwrap();
    assert!(fs::read_dir(&out_dir).unwrap().next().is_none());
}

#[test]
fn db_ledger_lands_in_its_own_directory_separate_from_the_tree_ledger() {
    let root = tmp_workspace("sqldb-layout");
    let mut sql = block_on(open_native_sql(&root, "session-a")).unwrap();
    let id = block_on(sql.create_database("Layout")).unwrap();
    block_on(sql.exec(&id, "CREATE TABLE t (v TEXT)", vec![], false)).unwrap();

    assert!(root.join("db-ledger").exists(), "sql events should be under db-ledger/, not ledger/");
    let entries: Vec<_> = fs::read_dir(root.join("db-ledger")).unwrap().collect();
    assert!(!entries.is_empty());
}
