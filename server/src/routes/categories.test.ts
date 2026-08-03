import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { renameCategory } from './transactions.js';

// Run: cd server && npx tsx src/routes/categories.test.ts
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE transactions (id INTEGER PRIMARY KEY, category TEXT);
  CREATE TABLE budgets (month TEXT, category TEXT, expected REAL, PRIMARY KEY (month, category));
  CREATE TABLE merchant_categories (merchant TEXT PRIMARY KEY, category TEXT);
  INSERT INTO transactions (category) VALUES ('groceries'), ('groceries'), ('Groceries'), ('Rent');
  INSERT INTO budgets VALUES ('2026-07','groceries',100), ('2026-07','Groceries',400), ('2026-08','groceries',150);
  INSERT INTO merchant_categories VALUES ('WHOLE FOODS','groceries');
`);

const moved = renameCategory(db as any, 'groceries', 'Groceries'); // merge lowercase into existing
assert.equal(moved, 2, 'two transactions should move');

const cats = db.prepare('SELECT category, COUNT(*) n FROM transactions GROUP BY category ORDER BY category').all();
assert.deepEqual(cats, [{ category: 'Groceries', n: 3 }, { category: 'Rent', n: 1 }], 'all groceries unified');

// July had both rows -> summed (100+400); August had only the source -> renamed (150).
const jul = db.prepare(`SELECT expected FROM budgets WHERE month='2026-07' AND category='Groceries'`).get() as { expected: number };
const aug = db.prepare(`SELECT expected FROM budgets WHERE month='2026-08' AND category='Groceries'`).get() as { expected: number };
assert.equal(jul.expected, 500, 'conflicting month budgets summed');
assert.equal(aug.expected, 150, 'non-conflicting month budget renamed');
assert.equal((db.prepare(`SELECT COUNT(*) n FROM budgets WHERE category='groceries'`).get() as { n: number }).n, 0, 'no source budget rows left');

const mc = db.prepare(`SELECT category FROM merchant_categories WHERE merchant='WHOLE FOODS'`).get() as { category: string };
assert.equal(mc.category, 'Groceries', 'learned merchant memory follows the rename');

console.log('categories.test.ts: all assertions passed');
