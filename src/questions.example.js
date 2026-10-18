// Template for the private question bank.
// Copy to src/questions.js and fill in your own questions (that file is git-ignored,
// because it contains the correct answers). The Worker imports ./questions.js.
//
// Types and their answer shape:
//   single   { opts:[...], ans: <index> }
//   multi    { opts:[...], ans: [<index>, ...] }
//   yesno    { st:[...statements], ans: [true|false, ...] }
//   dropdown { tpl:"text with {0} and {1}", dd:[{opts:[...], ans:<index>}, ...] }
//   order    { items:[...in the CORRECT order] }   (the server shuffles them)

export const PART_TITLES = [
  'Get or connect to data',
  'Power Query Editor & profiling',
  'Clean the data',
  'Shape & transform tables',
  'Combine queries & build keys',
  'Performance, parameters & M',
];

export const QUESTIONS = [
  { id: 1, part: 1, type: 'single', text: 'Example question?', opts: ['Wrong', 'Right', 'Wrong'], ans: 1, exp: 'Why B is right.' },
  { id: 2, part: 1, type: 'yesno', text: 'Select Yes or No for each statement.', st: ['True statement', 'False statement'], ans: [true, false], exp: 'Explanation.' },
];
