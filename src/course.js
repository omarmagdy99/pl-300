// Course structure (public: titles only, no answers).
// Parts are numbered globally 1..18 in this order. Exam ids:
//   part g              -> g          (1..18)
//   final of section d  -> 100 + d    (101, 102, 103)

export const SECTIONS = [
  {
    id: 1, title: 'Prepare the data', weight: '25–30%',
    parts: [
      'Get or connect to data',
      'Power Query Editor & profiling',
      'Clean the data',
      'Shape & transform tables',
      'Combine queries & build keys',
      'Performance, parameters & M',
    ],
  },
  {
    id: 2, title: 'Model the data', weight: '25–30%',
    parts: [
      'Design a star schema & set properties',
      'Relationships & cross-filtering',
      'Date tables & time intelligence',
      'DAX fundamentals: measures & context',
      'CALCULATE, filters & statistics',
      'Optimize model performance',
    ],
  },
  {
    id: 3, title: 'Visualize and analyze the data', weight: '25–30%',
    parts: [
      'Choose & format the right visual',
      'Filters, slicers & interactions',
      'Drillthrough, tooltips & bookmarks',
      'Analytics & AI visuals',
      'Layout, themes, accessibility & mobile',
      'Tables, matrices, KPIs & paginated reports',
    ],
  },
];

export const finalId = (section) => 100 + section;

// Flat list of parts: { g, section, local, title }
export const PARTS = [];
for (const s of SECTIONS) s.parts.forEach((title, i) => PARTS.push({ g: PARTS.length + 1, section: s.id, local: i + 1, title }));

// Every exam in learning order: part exams, then the section final.
export const EXAMS = [];
for (const s of SECTIONS) {
  PARTS.filter((p) => p.section === s.id).forEach((p) => EXAMS.push({ id: p.g, kind: 'part', section: s.id, local: p.local, title: p.title }));
  EXAMS.push({ id: finalId(s.id), kind: 'final', section: s.id, local: null, title: `${s.title} – final exam` });
}

export const sectionOfPart = (g) => PARTS[g - 1].section;
