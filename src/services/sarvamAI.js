/**
 * sarvamAI.js — Sarvam AI Service Wrapper
 *
 * Wraps Sarvam AI REST APIs for Indic speech-to-text and chat completion.
 *
 * @see https://docs.sarvam.ai/
 */

const axios    = require('axios');
const FormData = require('form-data');

const STT_URL  = process.env.SARVAM_STT_URL  || 'https://api.sarvam.ai/speech-to-text';
const CHAT_URL = process.env.SARVAM_CHAT_URL || 'https://api.sarvam.ai/v1/chat/completions';
const API_KEY  = process.env.SARVAM_API_KEY  || '';

const extractChatContent = (data) => {
  const message = data?.choices?.[0]?.message;
  const content = message?.content ?? data?.choices?.[0]?.text ?? data?.output_text ?? data?.content;

  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        return part?.text || part?.content || '';
      })
      .join('')
      .trim();
  }

  return '';
};

const normalizeHint = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

const isGenericStudyHint = (hint, { title, content, tag }) => {
  const text = normalizeHint(hint);
  if (!text) return true;

  const genericMarkers = [
    'start by identifying the core idea',
    'break the question into definitions',
    'key variables, and one simple example',
    'पहले',
    'मुख्य अवधारणा',
    'परिभाषा, ज़रूरी बिंदुओं',
  ];
  const markerHits = genericMarkers.filter(marker => text.includes(normalizeHint(marker))).length;

  const anchors = [title, content, tag]
    .join(' ')
    .split(/[^a-zA-Z0-9+#]+/)
    .map(token => token.trim().toLowerCase())
    .filter(token => token.length >= 4 && !['what', 'when', 'where', 'which', 'this', 'that', 'with', 'from'].includes(token));
  const uniqueAnchors = Array.from(new Set(anchors)).slice(0, 8);
  const anchorHits = uniqueAnchors.filter(token => text.includes(token.replace(/^#/, ''))).length;

  return markerHits >= 2 && anchorHits <= 1;
};

const createFallbackStudyHint = ({ title, content, tag }) => {
  const source = `${title || ''} ${content || ''}`.toLowerCase();
  const topic = title || content || 'this concept';
  const subject = tag && tag !== '#Other' ? tag.replace(/^#/, '') : 'the topic';
  const includes = (...terms) => terms.some(term => source.includes(term));

  // ── CS / Programming ─────────────────────────────────────────────────
  if (includes('closure', 'lexical scope')) {
    return [
      'English: A closure happens when an inner function remembers variables from its outer function even after the outer function has finished. Trace which variables are being captured.',
      'Hindi: Closure में inner function, outer function के खत्म होने के बाद भी उसकी variables को याद रखता है। पहले देखें कौन-सी variables capture हो रही हैं।',
    ].join('\n');
  }

  if (includes('base case', 'recursion', 'recursive')) {
    return [
      'English: In recursion, the base case is the stopping condition. Identify the smallest input where the answer is already known, then build the recursive step from there.',
      'Hindi: Recursion में base case रोकने की शर्त होती है। सबसे छोटा input पहचानें जिसका answer सीधे पता हो, फिर recursive step बनाएं।',
    ].join('\n');
  }

  if (includes('pointer', 'reference', 'dereference', 'address')) {
    return [
      `English: A pointer stores the memory address of another variable, not the value itself. Draw a box diagram: one box holds the address, the other holds the actual data. Dereferencing (*ptr) follows the address to get the data.`,
      `Hindi: Pointer किसी variable का memory address store करता है, value नहीं। एक box diagram बनाएं: एक box में address हो, दूसरे में actual data। Dereferencing (*ptr) address follow करके data लाता है।`,
    ].join('\n');
  }

  if (includes('middleware', 'express middleware')) {
    return [
      `English: Middleware is a function that sits between the request and the response. It can modify req/res objects, run checks (auth, logging), or end the cycle. Think of it like a checkpoint in a pipeline.`,
      `Hindi: Middleware request और response के बीच एक function है। यह req/res modify कर सकता है, checks (auth, logging) चला सकता है, या cycle खत्म कर सकता है। इसे pipeline में checkpoint समझें।`,
    ].join('\n');
  }

  if (includes('node', 'nodejs', 'node.js', 'event loop')) {
    return [
      `English: Node.js runs JavaScript on the server using a single-threaded event loop. It handles I/O asynchronously — when a file read or API call is waiting, Node moves to the next task instead of blocking.`,
      `Hindi: Node.js server पर single-threaded event loop से JavaScript चलाता है। I/O asynchronously handle होता है — जब file read या API call wait कर रहा हो, Node blocking के बजाय अगला task उठा लेता है।`,
    ].join('\n');
  }

  if (includes('stack', 'push', 'pop', 'lifo')) {
    return [
      'English: A stack follows Last-In-First-Out (LIFO). The last item pushed is the first one popped. Think of a stack of plates — you always take from the top.',
      'Hindi: Stack Last-In-First-Out (LIFO) follow करता है। सबसे आखिरी push हुआ item सबसे पहले pop होता है। Plates के stack की तरह — हमेशा ऊपर से लेते हैं।',
    ].join('\n');
  }

  if (includes('queue', 'fifo', 'enqueue', 'dequeue')) {
    return [
      'English: A queue follows First-In-First-Out (FIFO). Items enter at the rear and leave from the front, like a line at a ticket counter.',
      'Hindi: Queue First-In-First-Out (FIFO) follow करती है। Items पीछे से enter होते हैं और आगे से निकलते हैं, जैसे ticket counter पर line।',
    ].join('\n');
  }

  if (includes('binary tree', 'bst', 'binary search tree', 'tree traversal', 'inorder', 'preorder', 'postorder')) {
    return [
      'English: A binary tree has at most 2 children per node. In a BST, left child < parent < right child. For traversals: Inorder gives sorted order, Preorder visits root first, Postorder visits root last.',
      'Hindi: Binary tree में हर node के अधिकतम 2 children होते हैं। BST में left child < parent < right child। Inorder sorted order देता है, Preorder root पहले, Postorder root आखिर में visit करता है।',
    ].join('\n');
  }

  if (includes('graph', 'bfs', 'dfs', 'breadth first', 'depth first', 'adjacency')) {
    return [
      'English: Graphs consist of vertices and edges. BFS explores level by level using a queue, while DFS goes deep along one path using a stack/recursion. Choose BFS for shortest path, DFS for exploring all paths.',
      'Hindi: Graph vertices और edges से बनता है। BFS queue से level-by-level explore करता है, DFS stack/recursion से एक path में deep जाता है। Shortest path के लिए BFS, सब paths explore करने के लिए DFS चुनें।',
    ].join('\n');
  }

  if (includes('hash', 'hashmap', 'hash table', 'hashing', 'collision')) {
    return [
      'English: A hash table maps keys to values using a hash function. Collisions happen when two keys hash to the same index. Common solutions: chaining (linked list at each slot) or open addressing.',
      'Hindi: Hash table एक hash function से keys को values से map करता है। Collision तब होता है जब दो keys same index पर hash हों। Solutions: chaining (हर slot पर linked list) या open addressing।',
    ].join('\n');
  }

  if (includes('sort', 'sorting', 'bubble sort', 'merge sort', 'quick sort', 'selection sort', 'insertion sort')) {
    return [
      'English: Sorting arranges elements in order. Bubble/Selection/Insertion are O(n²) — simple but slow. Merge Sort is O(n log n) and stable. Quick Sort is O(n log n) average but O(n²) worst case. Pick based on data size and stability needs.',
      'Hindi: Sorting elements को order में लगाता है। Bubble/Selection/Insertion O(n²) हैं — simple पर slow। Merge Sort O(n log n) और stable है। Quick Sort average O(n log n) पर worst case O(n²)। Data size और stability के हिसाब से चुनें।',
    ].join('\n');
  }

  if (includes('dynamic programming', 'dp', 'memoization', 'tabulation')) {
    return [
      'English: Dynamic Programming solves problems by breaking them into overlapping subproblems. Use memoization (top-down, store results) or tabulation (bottom-up, fill a table). First identify the recurrence relation.',
      'Hindi: Dynamic Programming overlapping subproblems में तोड़कर solve करता है। Memoization (top-down, results store करो) या tabulation (bottom-up, table भरो) use करें। पहले recurrence relation पहचानें।',
    ].join('\n');
  }

  if (includes('oop', 'object oriented', 'class', 'inheritance', 'polymorphism', 'encapsulation', 'abstraction')) {
    return [
      'English: OOP has 4 pillars — Encapsulation (bundling data+methods), Inheritance (reusing parent class), Polymorphism (same method, different behavior), Abstraction (hiding complexity). Think of a real-world object and map these.',
      'Hindi: OOP के 4 pillars — Encapsulation (data+methods bundle), Inheritance (parent class reuse), Polymorphism (same method, अलग behavior), Abstraction (complexity छुपाना)। किसी real-world object पर map करके समझें।',
    ].join('\n');
  }

  if (includes('api', 'rest', 'restful', 'endpoint', 'http method')) {
    return [
      'English: REST APIs use HTTP methods: GET (read), POST (create), PUT/PATCH (update), DELETE (remove). Each endpoint represents a resource. Status codes tell the client what happened (200 OK, 404 Not Found, 500 Server Error).',
      'Hindi: REST APIs HTTP methods use करते हैं: GET (पढ़ो), POST (बनाओ), PUT/PATCH (update करो), DELETE (हटाओ)। हर endpoint एक resource represent करता है। Status codes बताते हैं क्या हुआ (200 OK, 404 Not Found, 500 Error)।',
    ].join('\n');
  }

  if (includes('sql', 'query', 'join', 'select', 'database', 'table')) {
    return [
      'English: SQL queries data from relational databases. SELECT picks columns, FROM picks the table, WHERE filters rows. JOINs combine related tables. Start with the simplest query and add clauses one by one.',
      'Hindi: SQL relational databases से data query करता है। SELECT columns चुनता है, FROM table, WHERE rows filter करता है। JOINs related tables combine करते हैं। सबसे simple query से शुरू करें और एक-एक clause जोड़ें।',
    ].join('\n');
  }

  // ── Web Development ──────────────────────────────────────────────────
  if (includes('semantic tag', 'semantic html', 'html')) {
    return [
      'English: Semantic HTML tags describe meaning, not just layout. Think of tags like header, nav, main, article, section, and footer as labels for page structure.',
      'Hindi: Semantic HTML tags layout नहीं, meaning बताते हैं। header, nav, main, article, section और footer page structure को साफ़ बनाते हैं।',
    ].join('\n');
  }

  if (includes('css', 'flexbox', 'flex', 'grid', 'layout')) {
    return [
      'English: Flexbox is for 1D layouts (row OR column). CSS Grid is for 2D layouts (rows AND columns). Use display:flex with justify-content and align-items. Use display:grid with grid-template-columns/rows.',
      'Hindi: Flexbox 1D layout (row या column) के लिए है। CSS Grid 2D layout (rows और columns) के लिए। Flex में justify-content और align-items use करें। Grid में grid-template-columns/rows use करें।',
    ].join('\n');
  }

  if (includes('react', 'component', 'useState', 'useEffect', 'hook', 'props', 'state')) {
    return [
      'English: React components are reusable UI pieces. useState manages local state, useEffect handles side effects (API calls, timers). Props flow down from parent to child. State changes trigger re-renders.',
      'Hindi: React components reusable UI pieces हैं। useState local state manage करता है, useEffect side effects (API calls, timers) handle करता है। Props parent से child को जाते हैं। State बदलने पर re-render होता है।',
    ].join('\n');
  }

  if (includes('javascript', 'promise', 'async', 'await', 'callback')) {
    return [
      'English: Promises handle asynchronous operations in JavaScript. A Promise can be pending, resolved, or rejected. async/await is syntactic sugar — await pauses until the Promise resolves, making async code look synchronous.',
      'Hindi: JavaScript में Promises asynchronous operations handle करते हैं। Promise pending, resolved, या rejected हो सकता है। async/await sugar syntax है — await Promise resolve होने तक रुकता है, async code synchronous जैसा दिखता है।',
    ].join('\n');
  }

  // ── Mathematics ──────────────────────────────────────────────────────
  if (includes('limit', 'calculus', 'derivative', 'differentiation', 'integration', 'integral')) {
    return [
      'English: A limit describes what value a function approaches as input approaches a point. Derivatives measure rate of change (slope). Integrals measure total accumulation (area). Start by understanding the geometric meaning.',
      'Hindi: Limit बताता है function किस value की तरफ जाता है जब input किसी point के पास जाए। Derivative rate of change (slope) मापता है। Integral total accumulation (area) मापता है। पहले geometric meaning समझें।',
    ].join('\n');
  }

  if (includes('matrix', 'matrices', 'determinant', 'linear algebra', 'eigenvalue', 'vector')) {
    return [
      'English: A matrix is a 2D array of numbers. Multiplication is row-by-column. The determinant tells if a matrix is invertible (non-zero = invertible). Eigenvalues show how a transformation scales along certain directions.',
      'Hindi: Matrix numbers का 2D array है। Multiplication row-by-column होता है। Determinant बताता है matrix invertible है या नहीं (non-zero = invertible)। Eigenvalues बताते हैं transformation कुछ directions में कैसे scale करता है।',
    ].join('\n');
  }

  if (includes('probability', 'statistics', 'mean', 'variance', 'standard deviation', 'bayes')) {
    return [
      'English: Probability measures likelihood of an event (0 to 1). Mean is the average, variance measures spread, standard deviation is its square root. Bayes\' theorem updates probability given new evidence.',
      'Hindi: Probability किसी event की likelihood मापता है (0 से 1)। Mean average है, variance spread मापता है, standard deviation उसका square root। Bayes\' theorem नई evidence मिलने पर probability update करता है।',
    ].join('\n');
  }

  // ── Physics ──────────────────────────────────────────────────────────
  if (includes('newton', 'force', 'motion', 'inertia', 'acceleration', 'momentum')) {
    return [
      'English: Newton\'s 3 laws: (1) Objects stay at rest/motion unless a force acts, (2) F = ma — force equals mass times acceleration, (3) Every action has an equal opposite reaction. Draw a free-body diagram first.',
      'Hindi: Newton के 3 नियम: (1) बिना force के वस्तु अपनी state में रहती है, (2) F = ma — force = mass × acceleration, (3) हर action की equal opposite reaction होती है। पहले free-body diagram बनाएं।',
    ].join('\n');
  }

  if (includes('circuit', 'ohm', 'resistance', 'current', 'voltage', 'capacitor', 'inductor')) {
    return [
      'English: Ohm\'s law: V = IR (Voltage = Current × Resistance). In series, resistances add up. In parallel, 1/R_total = 1/R1 + 1/R2. Draw the circuit, label all values, then apply Kirchhoff\'s laws.',
      'Hindi: Ohm\'s law: V = IR (Voltage = Current × Resistance)। Series में resistances जुड़ती हैं। Parallel में 1/R_total = 1/R1 + 1/R2। Circuit draw करें, सब values label करें, फिर Kirchhoff\'s laws लगाएं।',
    ].join('\n');
  }

  // ── Economics ─────────────────────────────────────────────────────────
  if (includes('balance', 'microeconomic', 'microeconomics', 'equilibrium', 'demand', 'supply')) {
    return [
      'English: In microeconomics, balance usually means equilibrium: the point where demand and supply are equal. Compare what buyers want with what sellers offer.',
      'Hindi: Microeconomics में balance अक्सर equilibrium होता है, जहाँ demand और supply बराबर होती हैं। Buyers की demand और sellers की supply मिलाकर सोचें।',
    ].join('\n');
  }

  if (includes('gdp', 'inflation', 'macroeconomic', 'fiscal', 'monetary', 'macro')) {
    return [
      'English: GDP measures total output of an economy. Inflation is the rate at which prices rise. Fiscal policy uses government spending/taxes, monetary policy uses interest rates and money supply to stabilize the economy.',
      'Hindi: GDP economy का total output मापता है। Inflation वह rate है जिससे prices बढ़ती हैं। Fiscal policy government spending/taxes, monetary policy interest rates और money supply use करके economy stabilize करती है।',
    ].join('\n');
  }

  // ── Chemistry ────────────────────────────────────────────────────────
  if (includes('bond', 'covalent', 'ionic', 'chemical bond', 'electron', 'atom')) {
    return [
      'English: Ionic bonds form when one atom gives electrons to another (metal + non-metal). Covalent bonds form when atoms share electrons (non-metal + non-metal). Electronegativity difference determines the bond type.',
      'Hindi: Ionic bond तब बनता है जब एक atom दूसरे को electron देता है (metal + non-metal)। Covalent bond में atoms electrons share करते हैं (non-metal + non-metal)। Electronegativity difference bond type तय करता है।',
    ].join('\n');
  }

  if (includes('redox', 'oxidation', 'reduction', 'reaction')) {
    return [
      'English: In redox reactions, oxidation is loss of electrons (OIL) and reduction is gain of electrons (RIG). One substance gets oxidized while another gets reduced. Track electron flow to identify which is which.',
      'Hindi: Redox reactions में oxidation electrons का loss (OIL) और reduction electrons का gain (RIG) है। एक substance oxidize होता है, दूसरा reduce। Electron flow track करके पहचानें कौन-सा कौन-सा है।',
    ].join('\n');
  }

  // ── Operating Systems ────────────────────────────────────────────────
  if (includes('fork', 'process', 'os', 'operating system', 'thread', 'scheduling')) {
    return [
      'English: Fork creates a new child process from an existing process. Track parent and child separately because both may continue executing after the fork call.',
      'Hindi: Fork existing process से नया child process बनाता है। Parent और child को अलग-अलग trace करें क्योंकि दोनों आगे execute कर सकते हैं।',
    ].join('\n');
  }

  if (includes('deadlock', 'mutex', 'semaphore', 'synchronization', 'critical section')) {
    return [
      'English: Deadlock occurs when two or more processes wait for each other\'s resources forever. Four conditions: mutual exclusion, hold & wait, no preemption, circular wait. Break any one condition to prevent deadlock.',
      'Hindi: Deadlock तब होता है जब दो या ज़्यादा processes एक-दूसरे के resources का हमेशा इंतज़ार करें। चार शर्तें: mutual exclusion, hold & wait, no preemption, circular wait। कोई एक शर्त तोड़ें deadlock रोकने के लिए।',
    ].join('\n');
  }

  // ── Networking ───────────────────────────────────────────────────────
  if (includes('tcp', 'udp', 'protocol', 'ip', 'network', 'osi', 'http', 'socket')) {
    return [
      'English: TCP is reliable (guaranteed delivery, ordered) but slower. UDP is fast but unreliable (no guarantee). HTTP runs over TCP. The OSI model has 7 layers — focus on Application, Transport, Network, and Data Link layers.',
      'Hindi: TCP reliable है (guaranteed delivery, ordered) पर slow। UDP fast पर unreliable (no guarantee)। HTTP TCP पर चलता है। OSI model में 7 layers हैं — Application, Transport, Network, और Data Link layers पर focus करें।',
    ].join('\n');
  }

  // ── Machine Learning ─────────────────────────────────────────────────
  if (includes('machine learning', 'neural network', 'regression', 'classification', 'overfitting', 'training', 'model')) {
    return [
      'English: ML models learn patterns from data. Regression predicts continuous values, classification predicts categories. Overfitting means the model memorized training data but fails on new data. Use validation sets to check.',
      'Hindi: ML models data से patterns सीखते हैं। Regression continuous values, classification categories predict करता है। Overfitting मतलब model ने training data याद कर लिया पर new data पर fail होता है। Validation sets से check करें।',
    ].join('\n');
  }

  if (includes('list', 'array', 'linked list')) {
    return [
      'English: A list stores items in order. Focus on how elements are added, accessed, removed, and whether positions/indexes matter in the problem.',
      'Hindi: List items को order में store करती है। देखें elements कैसे add, access और remove होते हैं, और index/position क्यों important है।',
    ].join('\n');
  }

  // ── Generic fallback (VARIED — cycles through 5 different templates) ─
  // Hash the topic string to pick a consistent but varied template
  const hash = [...(topic + subject)].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const templates = [
    () => [
      `English: Start by writing a one-line definition of "${topic}" in your own words. Then ask: why does this concept exist? What problem does it solve in ${subject}? Build your answer from that foundation.`,
      `Hindi: पहले "${topic}" की एक line में अपनी definition लिखें। फिर पूछें: यह concept क्यों बना? ${subject} में यह कौन-सी problem solve करता है? इसी foundation से answer बनाएं।`,
    ].join('\n'),
    () => [
      `English: Compare "${topic}" with something you already know in ${subject}. How are they similar? How are they different? Drawing a comparison table often makes the concept click.`,
      `Hindi: "${topic}" की तुलना ${subject} में किसी जानी हुई चीज़ से करें। कहाँ similar हैं? कहाँ different? Comparison table बनाने से concept जल्दी clear होता है।`,
    ].join('\n'),
    () => [
      `English: Think of a real-world analogy for "${topic}". For example, if it's a process, what everyday routine works similarly? Analogies make abstract ${subject} concepts concrete and memorable.`,
      `Hindi: "${topic}" के लिए एक real-world analogy सोचें। जैसे अगर यह एक process है, तो कौन-सी रोज़मर्रा की routine ऐसे ही काम करती है? Analogies abstract ${subject} concepts को concrete बनाती हैं।`,
    ].join('\n'),
    () => [
      `English: Break "${topic}" into 3 smaller questions: (1) What is it? (2) How does it work step by step? (3) Where is it used in ${subject}? Answer each separately, then combine.`,
      `Hindi: "${topic}" को 3 छोटे सवालों में तोड़ें: (1) यह क्या है? (2) Step by step कैसे काम करता है? (3) ${subject} में कहाँ use होता है? हर एक अलग-अलग answer करें, फिर combine करें।`,
    ].join('\n'),
    () => [
      `English: Try explaining "${topic}" to someone who knows nothing about ${subject}. If you get stuck, that's exactly the part you need to study. This is called the Feynman technique.`,
      `Hindi: "${topic}" किसी ऐसे person को explain करने की कोशिश करें जो ${subject} नहीं जानता। जहाँ अटकें, वही हिस्सा पढ़ना है। इसे Feynman technique कहते हैं।`,
    ].join('\n'),
  ];

  return templates[hash % templates.length]();
};

/**
 * Supported language codes (BCP-47) for Sarvam AI STT.
 * Each maps to an Indian regional language.
 */
const SUPPORTED_LANGUAGES = {
  'hi-IN': 'Hindi',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
  'bn-IN': 'Bengali',
  'kn-IN': 'Kannada',
  'mr-IN': 'Marathi',
  'gu-IN': 'Gujarati',
  'ml-IN': 'Malayalam',
  'pa-IN': 'Punjabi',
  'or-IN': 'Odia',
  'as-IN': 'Assamese',
  'ur-IN': 'Urdu',
  'en-IN': 'English (India)',
};

/**
 * Transcribes an audio buffer using Sarvam AI's speech-to-text API.
 *
 * @param {Buffer} audioBuffer    — Raw audio file bytes
 * @param {string} originalName   — Original filename (e.g. 'query.wav')
 * @param {string} mimeType       — MIME type (e.g. 'audio/wav')
 * @param {object} [options]
 * @param {string} [options.languageCode='hi-IN'] — BCP-47 language code
 * @param {string} [options.model='saaras:v3']     — Sarvam model version
 * @returns {Promise<{ transcript: string, languageCode: string, confidence: number }>}
 */
async function transcribeAudio(audioBuffer, originalName, mimeType, options = {}) {
  const {
    languageCode = 'hi-IN',
    model        = 'saaras:v3',
  } = options;

  if (!API_KEY) {
    throw Object.assign(
      new Error('Sarvam AI API key not configured. Set SARVAM_API_KEY in .env'),
      { statusCode: 503 },
    );
  }

  // Build multipart form data
  const form = new FormData();
  form.append('file', audioBuffer, {
    filename:    originalName || 'audio.wav',
    contentType: mimeType     || 'audio/wav',
  });
  form.append('language_code', languageCode);
  form.append('model', model);
  form.append('with_timestamps', 'false');

  try {
    const response = await axios.post(STT_URL, form, {
      headers: {
        ...form.getHeaders(),
        'api-subscription-key': API_KEY,
      },
      timeout: 30_000, // 30 s timeout
      maxContentLength: 20 * 1024 * 1024, // 20 MB max response
    });

    const data = response.data;

    return {
      transcript:   data.transcript  || '',
      languageCode: data.language_code || languageCode,
      confidence:   data.confidence   || null,
    };
  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      const body   = err.response.data;

      console.error(`❌ Sarvam AI API error (${status}):`, body);

      throw Object.assign(
        new Error(
          `Sarvam AI transcription failed: ${body?.message || body?.error || 'Unknown error'}`,
        ),
        { statusCode: status >= 500 ? 503 : 400 },
      );
    }

    // Network / timeout error
    console.error('❌ Sarvam AI network error:', err.message);
    throw Object.assign(
      new Error('Unable to reach Sarvam AI service. Please try again.'),
      { statusCode: 503 },
    );
  }
}

/**
 * Generates a short bilingual study hint for a forum doubt using Sarvam's
 * Indic LLM chat-completion endpoint.
 *
 * @param {object} doubt
 * @param {string} doubt.title
 * @param {string} doubt.content
 * @param {string} [doubt.tag]
 * @param {object} [options]
 * @param {string} [options.model='sarvam-30b']
 * @returns {Promise<{ hint: string, model: string, usage: object | null }>}
 */
async function generateStudyHint(doubt, options = {}) {
  const {
    model = process.env.SARVAM_CHAT_MODEL || 'sarvam-30b',
  } = options;

  const title = String(doubt?.title || '').trim();
  const content = String(doubt?.content || '').trim();
  const tag = String(doubt?.tag || 'General').trim();

  if (!title || !content) {
    return { hint: '', model, usage: null };
  }

  if (!API_KEY) {
    if (process.env.SARVAM_HINT_FALLBACK !== 'false') {
      return {
        hint: createFallbackStudyHint({ title, content, tag }),
        model,
        usage: null,
        fallback: true,
        warning: 'Sarvam AI API key not configured. Set SARVAM_API_KEY in .env',
      };
    }

    throw Object.assign(
      new Error('Sarvam AI API key not configured. Set SARVAM_API_KEY in .env'),
      { statusCode: 503 },
    );
  }

  const callSarvamChat = async (selectedModel, attempt = 'primary') => {
    const isSpecificRetry = attempt === 'specific-retry';
    const response = await axios.post(CHAT_URL, {
      model: selectedModel,
      messages: [
        {
          role: 'system',
          content: [
            'You are MindCraft AI Assist for Indian college students.',
            'Generate a brief conceptual study hint, not a full solution.',
            'Respond bilingually with English and Hindi in simple language.',
            'Keep it under 90 words total.',
            'Make the hint specific to the exact title, details, and tag.',
            'Do not use generic wording like "identify the core idea" unless you name the actual concept from the doubt.',
            'Avoid reusable templates. Mention the exact concept words from the student question.',
            isSpecificRetry
              ? 'Your previous answer was too generic. Rewrite it with one concrete clue, misconception, or mental model for this exact doubt.'
              : '',
            'Use this exact format:',
            'English: <hint>',
            'Hindi: <hint in Devanagari>',
          ].filter(Boolean).join(' '),
        },
        {
          role: 'user',
          content: [
            `Subject/tag: ${tag}`,
            `Question title: ${title}`,
            `Question details: ${content}`,
            isSpecificRetry
              ? 'Important: Do not answer with a generic study strategy. Give a concept-specific hint for this exact title and details.'
              : '',
          ].filter(Boolean).join('\n'),
        },
      ],
      temperature: isSpecificRetry ? 0.45 : 0.25,
      reasoning_effort: 'none',
      max_tokens: 220,
    }, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'api-subscription-key': API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: Number(process.env.SARVAM_CHAT_TIMEOUT_MS || 10_000),
    });

    const data = response.data;
    const hint = extractChatContent(data);

    return {
      hint,
      model: data?.model || selectedModel,
      usage: data?.usage || null,
      raw: data,
    };
  };

  try {
    let result = await callSarvamChat(model);
    if (!result.hint && model !== 'sarvam-105b') {
      console.warn(`Sarvam AI returned empty hint with ${model}; retrying with sarvam-105b`);
      result = await callSarvamChat('sarvam-105b');
    }

    if (result.hint && isGenericStudyHint(result.hint, { title, content, tag })) {
      console.warn(`Sarvam AI returned generic hint with ${result.model || model}; retrying with a stricter prompt`);
      const retryModel = result.model || model;
      const retry = await callSarvamChat(retryModel, 'specific-retry');
      if (retry.hint && !isGenericStudyHint(retry.hint, { title, content, tag })) {
        result = retry;
      }
    }

    if (!result.hint || isGenericStudyHint(result.hint, { title, content, tag })) {
      return {
        hint: createFallbackStudyHint({ title, content, tag }),
        model: result.model || model,
        usage: result.usage || null,
        fallback: true,
        warning: result.hint ? 'Sarvam AI returned a generic repeated hint.' : 'Sarvam AI returned an empty response.',
      };
    }

    return {
      hint: result.hint,
      model: result.model,
      usage: result.usage,
      fallback: false,
    };
  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      const body = err.response.data;

      console.error(`❌ Sarvam AI chat API error (${status}):`, body);

      if (process.env.SARVAM_HINT_FALLBACK !== 'false') {
        return {
          hint: createFallbackStudyHint({ title, content, tag }),
          model,
          usage: null,
          fallback: true,
          warning: `Sarvam AI study hint failed: ${body?.message || body?.error || 'Unknown error'}`,
        };
      }

      throw Object.assign(new Error(`Sarvam AI study hint failed: ${body?.message || body?.error || 'Unknown error'}`), { statusCode: status >= 500 ? 503 : 400 });
    }

    console.error('❌ Sarvam AI chat network error:', err.message);
    if (process.env.SARVAM_HINT_FALLBACK !== 'false') {
      return {
        hint: createFallbackStudyHint({ title, content, tag }),
        model,
        usage: null,
        fallback: true,
        warning: 'Unable to reach Sarvam AI chat service.',
      };
    }

    throw Object.assign(
      new Error('Unable to reach Sarvam AI chat service. Please try again.'),
      { statusCode: 503 },
    );
  }
}

module.exports = {
  generateStudyHint,
  transcribeAudio,
  SUPPORTED_LANGUAGES,
  isGenericStudyHint,
};
