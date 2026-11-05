// Static content the platform owns: the daily-question bank, the achievement
// catalogue and the weekly challenge definitions. Kept server-side so rewards
// cannot be tuned from the browser.

// subject, question, 4 options, answer index, explanation
export const QUESTION_BANK = [
  { s: 'Physics', q: 'What is the SI unit of electric current?', o: ['Volt', 'Ampere', 'Ohm', 'Watt'], a: 1, e: 'Current is the rate of flow of charge; one ampere is one coulomb per second.' },
  { s: 'Physics', q: 'The acceleration due to gravity near Earth’s surface is about…', o: ['8.9 m/s²', '9.8 m/s²', '10.8 m/s²', '9.3 m/s²'], a: 1, e: 'g ≈ 9.8 m/s² downward, ignoring air resistance.' },
  { s: 'Physics', q: 'Which law states F = ma?', o: ['Newton’s first law', 'Newton’s second law', 'Newton’s third law', 'Ohm’s law'], a: 1, e: 'The second law: net force equals mass times acceleration.' },
  { s: 'Physics', q: 'Energy stored in a moving object is called…', o: ['Potential energy', 'Kinetic energy', 'Thermal energy', 'Nuclear energy'], a: 1, e: 'Kinetic energy = ½mv².' },
  { s: 'Physics', q: 'Sound cannot travel through…', o: ['Water', 'Steel', 'A vacuum', 'Air'], a: 2, e: 'Sound is a mechanical wave and needs a medium.' },
  { s: 'Physics', q: 'The unit of electrical resistance is the…', o: ['Farad', 'Henry', 'Ohm', 'Siemens'], a: 2, e: 'R = V/I, measured in ohms (Ω).' },
  { s: 'Chemistry', q: 'What is the chemical formula of water?', o: ['H₂O₂', 'HO', 'H₂O', 'OH⁻'], a: 2, e: 'Two hydrogen atoms bonded to one oxygen atom.' },
  { s: 'Chemistry', q: 'The pH of a neutral solution at 25 °C is…', o: ['0', '7', '14', '1'], a: 1, e: 'Neutral means [H⁺] = [OH⁻] = 10⁻⁷ M, so pH = 7.' },
  { s: 'Chemistry', q: 'Which gas is produced when a metal reacts with an acid?', o: ['Oxygen', 'Hydrogen', 'Carbon dioxide', 'Nitrogen'], a: 1, e: 'Metal + acid → salt + hydrogen gas.' },
  { s: 'Chemistry', q: 'The number of protons in an atom is its…', o: ['Mass number', 'Atomic number', 'Valency', 'Isotope number'], a: 1, e: 'Atomic number Z = number of protons; it defines the element.' },
  { s: 'Chemistry', q: 'Table salt is chemically known as…', o: ['Sodium chloride', 'Potassium nitrate', 'Calcium carbonate', 'Magnesium sulfate'], a: 0, e: 'NaCl, formed from Na⁺ and Cl⁻ ions.' },
  { s: 'Chemistry', q: 'Avogadro’s number is approximately…', o: ['6.02 × 10²³', '3.14 × 10⁸', '1.6 × 10⁻¹⁹', '9.8 × 10¹⁰'], a: 0, e: 'One mole contains about 6.022 × 10²³ particles.' },
  { s: 'Mathematics', q: 'Solve: 3x + 7 = 22. What is x?', o: ['3', '5', '7', '15'], a: 1, e: '3x = 15, so x = 5.' },
  { s: 'Mathematics', q: 'The value of π (to two decimals) is…', o: ['3.12', '3.14', '3.16', '3.41'], a: 1, e: 'π ≈ 3.14159, so 3.14 to two decimals.' },
  { s: 'Mathematics', q: 'What is the derivative of x²?', o: ['x', '2x', 'x²/2', '2'], a: 1, e: 'd/dx xⁿ = n·xⁿ⁻¹, so d/dx x² = 2x.' },
  { s: 'Mathematics', q: 'In a right triangle with legs 3 and 4, the hypotenuse is…', o: ['5', '6', '7', '12'], a: 0, e: 'Pythagoras: √(9 + 16) = 5.' },
  { s: 'Mathematics', q: 'The sum of the interior angles of a triangle is…', o: ['90°', '180°', '270°', '360°'], a: 1, e: 'Always 180° in Euclidean geometry.' },
  { s: 'Mathematics', q: 'What is 7! (7 factorial)?', o: ['720', '2400', '5040', '40320'], a: 2, e: '7 × 6 × 5 × 4 × 3 × 2 × 1 = 5040.' },
  { s: 'Biology', q: 'The powerhouse of the cell is the…', o: ['Ribosome', 'Mitochondrion', 'Nucleus', 'Golgi body'], a: 1, e: 'Mitochondria produce ATP through respiration.' },
  { s: 'Biology', q: 'Photosynthesis mainly takes place in the…', o: ['Chloroplast', 'Vacuole', 'Lysosome', 'Centriole'], a: 0, e: 'Chlorophyll in chloroplasts captures light energy.' },
  { s: 'Biology', q: 'Human DNA is made of two strands forming a…', o: ['Single helix', 'Double helix', 'Triple loop', 'Flat sheet'], a: 1, e: 'The double-helix model was described by Watson and Crick.' },
  { s: 'Biology', q: 'Which organ filters blood and produces urine?', o: ['Liver', 'Kidney', 'Lung', 'Pancreas'], a: 1, e: 'Kidneys contain nephrons that filter blood.' },
  { s: 'English', q: 'Which word is a conjunction?', o: ['Quickly', 'Because', 'Beautiful', 'Run'], a: 1, e: 'Conjunctions join clauses; “because” is subordinating.' },
  { s: 'English', q: 'Choose the correct sentence.', o: ['She go to school.', 'She goes to school.', 'She going to school.', 'She gone to school.'], a: 1, e: 'Third-person singular present takes -s: “she goes”.' },
  { s: 'English', q: 'A word that describes a verb is an…', o: ['Adjective', 'Adverb', 'Article', 'Pronoun'], a: 1, e: 'Adverbs modify verbs, adjectives or other adverbs.' },
  { s: 'English', q: 'The past participle of “write” is…', o: ['wrote', 'writed', 'written', 'writing'], a: 2, e: 'write – wrote – written.' },
  { s: 'Computer Science', q: 'What does CPU stand for?', o: ['Central Process Unit', 'Central Processing Unit', 'Computer Personal Unit', 'Control Program Utility'], a: 1, e: 'The Central Processing Unit executes instructions.' },
  { s: 'Computer Science', q: 'Binary number 1010 equals which decimal value?', o: ['8', '10', '12', '16'], a: 1, e: '8 + 0 + 2 + 0 = 10.' },
  { s: 'Computer Science', q: 'Which structure works on a first-in-first-out basis?', o: ['Stack', 'Queue', 'Tree', 'Graph'], a: 1, e: 'Queues are FIFO; stacks are LIFO.' },
  { s: 'Computer Science', q: 'An algorithm that repeats by calling itself is…', o: ['Iterative', 'Recursive', 'Linear', 'Random'], a: 1, e: 'Recursion needs a base case to stop.' },
  { s: 'Islamiyat', q: 'How many pillars (Arkan) of Islam are there?', o: ['Three', 'Four', 'Five', 'Six'], a: 2, e: 'Shahadat, Namaz, Roza, Zakat and Hajj.' },
  { s: 'Islamiyat', q: 'In which month do Muslims observe fasting?', o: ['Shawal', 'Rajab', 'Ramadan', 'Muharram'], a: 2, e: 'Ramadan is the ninth month of the Islamic calendar.' },
  { s: 'Islamiyat', q: 'How many surahs are in the Holy Quran?', o: ['100', '110', '114', '120'], a: 2, e: 'The Quran contains 114 surahs.' },
  { s: 'Islamiyat', q: 'Zakat is calculated as approximately what portion of qualifying wealth?', o: ['1/10', '1/20', '1/40', '1/100'], a: 2, e: '2.5% of qualifying wealth, i.e. one-fortieth.' },
  { s: 'General', q: 'The capital of Pakistan is…', o: ['Karachi', 'Lahore', 'Islamabad', 'Peshawar'], a: 2, e: 'Islamabad has been the capital since the 1960s.' },
  { s: 'General', q: 'Which river is the longest in Pakistan?', o: ['Ravi', 'Indus', 'Jhelum', 'Gomal'], a: 1, e: 'The Indus runs roughly 3,000 km from Tibet to the Arabian Sea.' },
  { s: 'General', q: 'The highest mountain peak in the world is…', o: ['K2', 'Mt Everest', 'Nanga Parbat', 'Mt Blanc'], a: 1, e: 'Everest at 8,849 m; K2 (8,611 m) is the second highest.' },
  { s: 'General', q: 'Which planet is known as the Red Planet?', o: ['Venus', 'Mars', 'Jupiter', 'Mercury'], a: 1, e: 'Iron oxide dust gives Mars its red colour.' },
];

export const ACHIEVEMENTS = [
  { code: 'first_space', title: 'First learning space created', reward: 20 },
  { code: 'first_book', title: 'First book added to the library', reward: 20 },
  { code: 'first_chapter_scan', title: 'First chapter scanned', reward: 20 },
  { code: 'first_quiz', title: 'First quiz completed', reward: 15 },
  { code: 'first_session', title: 'First study session finished', reward: 15 },
  { code: 'first_game', title: 'First Game Center round played', reward: 10 },
  { code: 'first_scan_tool', title: 'First Smart Scanner extraction reviewed', reward: 15 },
  { code: 'five_quizzes', title: 'Five quizzes completed', reward: 30 },
  { code: 'chapter_finished', title: 'A chapter marked as finished', reward: 40 },
  { code: 'milestone_60min', title: 'Studied 60 minutes in one day', reward: 25 },
  { code: 'milestone_300min', title: 'Reached 300 total study minutes', reward: 25 },
  { code: 'streak_3', title: '3-day learning streak', reward: 30 },
  { code: 'streak_7', title: '7-day learning streak', reward: 100 },
  { code: 'streak_14', title: '14-day learning streak', reward: 150 },
  { code: 'streak_30', title: '30-day learning streak', reward: 300 },
  { code: 'weekly_challenge', title: 'Weekly challenge completed', reward: 50 },
];

// Weekly challenges are evaluated from real rows the student already produced.
export const WEEKLY_CHALLENGES = [
  { code: 'ch_study_90', title: 'Study 90 focus minutes this week', metric: 'minutes', target: 90 },
  { code: 'ch_quiz_3', title: 'Complete 3 quizzes this week', metric: 'quizzes', target: 3 },
  { code: 'ch_scan_2', title: 'Extract 2 chapter pages this week', metric: 'pages', target: 2 },
  { code: 'ch_spaces_3', title: 'Study in 3 different spaces this week', metric: 'spaces', target: 3 },
  { code: 'ch_game_5', title: 'Play 5 Game Center rounds this week', metric: 'games', target: 5 },
];

export const GAME_CATALOG = [
  { game: 'math-rush', name: 'Math Rush', blurb: 'Fast arithmetic chains against the clock.', icon: '⚡', difficulties: ['easy', 'normal', 'hard'], how: 'Type the answer to each sum and press Enter. Each correct answer scores points; a perfect round adds a bonus.' },
  { game: 'number-puzzle', name: 'Number Puzzle', blurb: 'Find the missing number that completes each grid rule.', icon: '🔢', difficulties: ['easy', 'normal', 'hard'], how: 'Every row follows one hidden rule. Work out the rule, then pick the number that replaces the question mark.' },
  { game: 'equation-challenge', name: 'Equation Challenge', blurb: 'Solve for x, one balanced equation at a time.', icon: '🧮', difficulties: ['easy', 'normal', 'hard'], how: 'Isolate x in each equation and type its value. Brackets appear on the harder levels.' },
  { game: 'mental-sprint', name: 'Mental Math Sprint', blurb: 'Sixty seconds, as many correct sums as you can manage.', how: 'You have 60 seconds. Type each answer and press Enter - unanswered sums simply pass.', icon: '⏱', difficulties: ['easy', 'normal', 'hard'] },
  { game: 'pattern-recognition', name: 'Pattern Recognition', blurb: 'Spot the rule in the sequence and pick the next term.', how: 'Read the sequence, find how it changes, then choose the next term from the four options.', icon: '🧩', difficulties: ['easy', 'normal', 'hard'] },
  { game: 'quick-logic', name: 'Quick Logic', blurb: 'Short reasoning puzzles that reward careful reading.', how: 'Read each short puzzle carefully and choose the answer that must be true. Careful reading beats speed here.', icon: '🧠', difficulties: ['easy', 'normal', 'hard'] },
  { game: 'memory-challenge', name: 'Memory Challenge', blurb: 'Watch the sequence, then repeat it from memory.', how: 'Each round flashes a sequence of tiles. Watch it, then click the tiles in exactly the same order.', icon: '👁', difficulties: ['easy', 'normal', 'hard'] },
  { game: 'science-quiz', name: 'Science Quiz', blurb: 'Physics, Chemistry, Biology and general science MCQs.', how: 'Answer four-option science MCQs. Harder levels mix in more subjects.', icon: '🔬', difficulties: ['easy', 'normal', 'hard'] },
];

// Score is validated server-side against the challenge set issued at start.
export const GAME_RULES = {
  'math-rush': { rounds: { easy: 8, normal: 12, hard: 16 }, perCorrect: 2, bonusCap: 10 },
  'number-puzzle': { rounds: { easy: 5, normal: 7, hard: 9 }, perCorrect: 4, bonusCap: 12 },
  'equation-challenge': { rounds: { easy: 5, normal: 8, hard: 10 }, perCorrect: 4, bonusCap: 12 },
  'mental-sprint': { rounds: { easy: 10, normal: 14, hard: 20 }, perCorrect: 2, bonusCap: 8, timed: 60 },
  'pattern-recognition': { rounds: { easy: 6, normal: 8, hard: 10 }, perCorrect: 4, bonusCap: 12 },
  'quick-logic': { rounds: { easy: 5, normal: 7, hard: 9 }, perCorrect: 5, bonusCap: 15 },
  'memory-challenge': { rounds: { easy: 4, normal: 6, hard: 8 }, perCorrect: 5, bonusCap: 15 },
  'science-quiz': { rounds: { easy: 5, normal: 8, hard: 12 }, perCorrect: 4, bonusCap: 12 },
};

export const SUBJECT_SUGGESTIONS = ['Physics', 'Chemistry', 'Mathematics', 'Biology', 'Islamiyat', 'English Grammar', 'Computer Science', 'Urdu', 'History', 'Economics'];
