import assert from 'node:assert';
import { matchRule } from '../statements.js';

// Run: cd server && npx tsx src/routes/rules.test.ts
const rules = [
  { keyword: 'ALLY', category: 'Car Finance' },
  { keyword: 'PECAN', category: 'Rent' },
  { keyword: 'UNIV', category: 'Tuition' },
  { keyword: 'CUIS', category: 'Dining Out' },
];

// Token-prefix matches across description variants.
assert.equal(matchRule('ALLY FINANCIAL PAYMENT', rules), 'Car Finance');
assert.equal(matchRule('ACH DEBIT ALLY AUTO PMT', rules), 'Car Finance', 'brand not in first two words still matches');
assert.equal(matchRule('PECAN GROVE APARTMENTS', rules), 'Rent');
assert.equal(matchRule('UNIVERSITY OF LOUISIANA', rules), 'Tuition', 'UNIV is a prefix of UNIVERSITY');
assert.equal(matchRule('THAI CUISINE #42', rules), 'Dining Out', 'keyword can appear mid-description');
assert.equal(matchRule('india cuisine llc', rules), 'Dining Out', 'case-insensitive');

// Must NOT false-match on substrings inside other words.
assert.equal(matchRule('TOTALLY FREE WIFI', rules), null, '"ally" is not a token prefix of "totally"');
assert.equal(matchRule('WALMART GROCERY', rules), null, 'no rule applies');

// Longest keyword wins when two could match.
assert.equal(matchRule('UNIVERSITY BOOKSTORE', [
  { keyword: 'UNIV', category: 'Tuition' },
  { keyword: 'UNIVERSITY', category: 'Books' },
]), 'Books', 'more specific keyword wins');

console.log('rules.test.ts: all assertions passed');
