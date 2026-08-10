// handlers.mjs — mock server implementation for restful-booker-platform-style API
// Plain ESM, no deps, no build step. export default { reset(), handle(req) }

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const SEED_BRANDING = {
  address: {
    county: 'Dilbery',
    line1: 'Shady Meadows B&B',
    line2: 'Shadows valley',
    postCode: 'N1 1AA',
    postTown: 'Newingtonfordburyshire',
  },
  contact: {
    email: 'fake@fakeemail.com',
    name: 'Shady Meadows B&B',
    phone: '012345678901',
  },
  description:
    'Welcome to Shady Meadows, a delightful Bed & Breakfast nestled in the hills on Newingtonfordburyshire. A place so beautiful you will never want to leave. All our rooms have comfortable beds and we provide breakfast from the locally sourced supermarket. It is a delightful place.',
  directions:
    'Welcome to Shady Meadows, a delightful Bed & Breakfast nestled in the hills on Newingtonfordburyshire. A place so beautiful you will never want to leave. All our rooms have comfortable beds and we provide breakfast from the locally sourced supermarket. It is a delightful place.',
  logoUrl: '/images/rbp-logo.jpg',
  map: { latitude: 52.6351204, longitude: 1.2733774 },
  name: 'Shady Meadows B&B',
};

const SEED_ROOMS = [
  {
    accessible: true,
    description:
      'Aenean porttitor mauris sit amet lacinia molestie. In posuere accumsan aliquet. Maecenas sit amet nisl massa. Interdum et malesuada fames ac ante.',
    features: ['TV', 'WiFi', 'Safe'],
    image: '/images/room1.jpg',
    roomName: '101',
    roomPrice: 100,
    roomid: 1,
    type: 'Single',
  },
  {
    accessible: true,
    description:
      'Vestibulum sollicitudin, lectus ac mollis consequat, lorem orci ultrices tellus, eleifend euismod tortor dui egestas erat. Phasellus et ipsum nisl. ',
    features: ['TV', 'Radio', 'Safe'],
    image: '/images/room2.jpg',
    roomName: '102',
    roomPrice: 150,
    roomid: 2,
    type: 'Double',
  },
  {
    accessible: true,
    description:
      'Etiam metus metus, fringilla ac sagittis id, consequat vel neque. Nunc commodo quis nisl nec posuere. Etiam at accumsan ex. ',
    features: ['Radio', 'WiFi', 'Safe'],
    image: '/images/room3.jpg',
    roomName: '103',
    roomPrice: 225,
    roomid: 3,
    type: 'Suite',
  },
];

const SEED_REPORT = [
  { end: '2026-02-05', start: '2026-02-01', title: 'James Dean - Room: 101' },
  { end: '2026-08-22', start: '2026-08-20', title: 'Jane Doe - Room: 101' },
  { end: '2026-02-04', start: '2026-02-02', title: 'Erica Bowthorpe - Room: 102' },
  { end: '2026-03-05', start: '2026-03-01', title: 'Timothy Barrow - Room: 103' },
  { end: '2026-04-18', start: '2026-04-11', title: 'Test User - Room: 103' },
];

// per-room "unavailable" report windows, derived from SEED_REPORT titles
const SEED_ROOM_REPORT = {
  1: [
    { start: '2026-02-01', end: '2026-02-05', title: 'Unavailable' },
    { start: '2026-08-20', end: '2026-08-22', title: 'Unavailable' },
  ],
  2: [{ start: '2026-02-02', end: '2026-02-04', title: 'Unavailable' }],
  3: [
    { start: '2026-03-01', end: '2026-03-05', title: 'Unavailable' },
    { start: '2026-04-11', end: '2026-04-18', title: 'Unavailable' },
  ],
};

const SEED_MESSAGES = [
  { id: 1, name: 'James Dean', email: 'james.dean@example.com', phone: '07123456780', read: false, subject: 'Booking enquiry', description: 'I would like to know more about booking a room for a weekend stay in the near future.' },
  { id: 2, name: 'Test User', email: 'test.user@example.com', phone: '07123456781', read: false, subject: 'You have a new booking!', description: 'This is an automated notification regarding a new booking that has just been made on the site.' },
  { id: 3, name: 'Jan Kowalski', email: 'jan.kowalski@example.com', phone: '07123456782', read: false, subject: 'Booking inquiry', description: 'I have a question about availability for the double room next month, please advise.' },
  { id: 4, name: 'Jan Kowalski', email: 'jan.kowalski@example.com', phone: '07123456782', read: false, subject: 'Booking inquiry', description: 'I have a question about availability for the double room next month, please advise.' },
  { id: 5, name: 'Jan Kowalski', email: 'jan.kowalski@example.com', phone: '07123456782', read: false, subject: 'Booking inquiry', description: 'I have a question about availability for the double room next month, please advise.' },
  { id: 6, name: 'Jane Doe', email: 'jane.doe@example.com', phone: '07123456783', read: false, subject: 'You have a new booking!', description: 'This is an automated notification regarding a new booking that has just been made on the site.' },
  { id: 7, name: 'Jan Kowalski', email: 'jan.kowalski@example.com', phone: '07123456782', read: false, subject: 'Booking inquiry', description: 'I have a question about availability for the double room next month, please advise.' },
  { id: 8, name: 'Jan Kowalski', email: 'jan.kowalski@example.com', phone: '07123456782', read: false, subject: 'Booking inquiry', description: 'I have a question about availability for the double room next month, please advise.' },
  { id: 9, name: 'Jan Kowalski', email: 'jan.kowalski@example.com', phone: '07123456782', read: false, subject: 'Booking inquiry', description: 'I have a question about availability for the double room next month, please advise.' },
  {
    id: 10,
    name: 'Alice Smith',
    email: 'alice.smith@example.com',
    phone: '07123456789',
    read: true,
    subject: 'Question about amenities',
    description: 'Hello, I would like to know if breakfast is included with the suite booking and whether late checkout is available for guests.',
  },
  { id: 11, name: 'Jan Kowalski', email: 'jan.kowalski@example.com', phone: '07123456782', read: false, subject: 'Booking inquiry', description: 'I have a question about availability for the double room next month, please advise.' },
  { id: 12, name: 'Jan Kowalski', email: 'jan.kowalski@example.com', phone: '07123456782', read: false, subject: 'Booking inquiry', description: 'I have a question about availability for the double room next month, please advise.' },
  { id: 13, name: 'Jan Kowalski', email: 'jan.kowalski@example.com', phone: '07123456782', read: false, subject: 'Booking inquiry', description: 'I have a question about availability for the double room next month, please advise.' },
];

const BUILD_ID = 'R4rZclRU8jbZ8aHkVb_rx';

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

let branding;
let rooms;
let report;
let roomReport;
let messages;
let nextMessageId;
let validTokens;
let bookings;
let nextBookingId;

function seed() {
  branding = JSON.parse(JSON.stringify(SEED_BRANDING));
  rooms = JSON.parse(JSON.stringify(SEED_ROOMS));
  report = JSON.parse(JSON.stringify(SEED_REPORT));
  roomReport = JSON.parse(JSON.stringify(SEED_ROOM_REPORT));
  messages = JSON.parse(JSON.stringify(SEED_MESSAGES));
  nextMessageId = messages.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  validTokens = new Set();
  bookings = [];
  nextBookingId = 1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(status, body) {
  return { status, contentType: 'application/json', body };
}

function tryParseJson(body) {
  if (body === undefined || body === null || body === '') return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

// deterministic hash-based token, no Math.random / Date.now
function deterministicToken(seedStr) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < seedStr.length; i++) {
    const c = seedStr.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 15), 2246822519) >>> 0;
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  let state = (h1 ^ h2) >>> 0;
  for (let i = 0; i < 16; i++) {
    state = (Math.imul(state ^ (state >>> 13), 2654435761) + i) >>> 0;
    out += chars[state % chars.length];
  }
  return out;
}

function rscStub(routeName, extra) {
  const tree = {
    tree: {
      name: '',
      param: null,
      prefetchHints: 16,
      slots: {
        children: {
          name: routeName.replace(/^\//, ''),
          param: null,
          prefetchHints: 0,
          slots: { children: { name: '__PAGE__', param: null, prefetchHints: 0, slots: null } },
        },
      },
    },
    staleTime: 300,
    buildId: BUILD_ID,
  };
  const body = `0:${JSON.stringify(tree)}\n`;
  return { status: 200, contentType: 'text/x-component', body: extra ? extra + body : body };
}

function htmlStub(title) {
  return (
    `<!DOCTYPE html><html lang="en" id="root"><head><meta charSet="utf-8"/>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"/>` +
    `<title>${title}</title></head><body><div id="__next"></div></body></html>`
  );
}

function validateMessage(m) {
  const errors = [];
  const name = m.name ?? '';
  const email = m.email ?? '';
  const phone = m.phone ?? '';
  const subject = m.subject ?? '';
  const description = m.description ?? '';

  if (email.trim() === '') errors.push('Email may not be blank');

  if (subject.length < 5 || subject.length > 100) errors.push('Subject must be between 5 and 100 characters.');
  if (subject.trim() === '') errors.push('Subject may not be blank');

  if (phone.length < 11 || phone.length > 21) errors.push('Phone must be between 11 and 21 characters.');
  if (phone.trim() === '') errors.push('Phone may not be blank');

  if (name.trim() === '') errors.push('Name may not be blank');

  if (description.length < 20 || description.length > 2000) errors.push('Message must be between 20 and 2000 characters.');
  if (description.trim() === '') errors.push('Message may not be blank');

  return errors;
}

// Booking validation, mirrors observed 400 error shape: {"errors":[...]}
// firstname: NotBlank + Size(3,30)
// lastname:  NotBlank + Size(3,18)
// email:     NotEmpty (no size rule observed)
// phone:     NotEmpty + Size(11,21)
function validateBooking(b) {
  const errors = [];
  const firstname = b.firstname ?? '';
  const lastname = b.lastname ?? '';
  const email = b.email ?? '';
  const phone = b.phone ?? '';

  if (firstname.length < 3 || firstname.length > 30) errors.push('size must be between 3 and 30');
  if (lastname.length < 3 || lastname.length > 18) errors.push('size must be between 3 and 18');
  if (email.trim() === '') errors.push('must not be empty');
  if (phone.length < 11 || phone.length > 21) errors.push('size must be between 11 and 21');
  if (firstname.trim() === '') errors.push('Firstname should not be blank');
  if (lastname.trim() === '') errors.push('Lastname should not be blank');
  if (phone.trim() === '') errors.push('must not be empty');

  return errors;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

const RSC_TEXT_ROUTES = new Set(['/', '/admin', '/admin/rooms', '/admin/message', '/admin/report', '/admin/branding', '/cookie', '/privacy']);

async function handle(req) {
  const { method, path: p, query, body } = req;

  // --- static/framework-ish routes -----------------------------------
  if (method === 'GET' && RSC_TEXT_ROUTES.has(p)) {
    if ('_rsc' in query) return rscStub(p);
    // no _rsc param -> full document render
    return { status: 200, contentType: p === '/' || p === '/admin' ? 'text/x-component' : 'text/html; charset=utf-8', body: htmlStub('Restful-booker-platform demo') };
  }

  if (method === 'GET' && p.startsWith('/reservation/')) {
    const id = p.slice('/reservation/'.length);
    const room = rooms.find((r) => String(r.roomid) === id);
    const title = room ? `Reservation for room ${room.roomName}` : 'Reservation';
    return { status: 200, contentType: 'text/html; charset=utf-8', body: htmlStub(title) };
  }

  // --- branding --------------------------------------------------------
  if (method === 'GET' && p === '/api/branding') {
    return json(200, branding);
  }

  // --- rooms -------------------------------------------------------------
  if (method === 'GET' && p === '/api/room') {
    return json(200, { rooms });
  }

  if (method === 'GET' && p.startsWith('/api/room/')) {
    const idStr = p.slice('/api/room/'.length);
    const id = Number(idStr);
    const room = rooms.find((r) => r.roomid === id);
    if (!room) return json(404, { error: 'Room not found' });
    return json(200, room);
  }

  // --- report --------------------------------------------------------------
  if (method === 'GET' && p === '/api/report') {
    return json(200, { report });
  }

  if (method === 'GET' && p.startsWith('/api/report/room/')) {
    const idStr = p.slice('/api/report/room/'.length);
    const id = Number(idStr);
    const rep = roomReport[id] || [];
    return json(200, { report: rep });
  }

  // --- messages --------------------------------------------------------------
  if (method === 'GET' && p === '/api/message/count') {
    return json(200, { count: messages.length });
  }

  if (method === 'GET' && p === '/api/message') {
    return json(200, {
      messages: messages.map((m) => ({ id: m.id, name: m.name, read: m.read, subject: m.subject })),
    });
  }

  if (method === 'GET' && p.startsWith('/api/message/') && !p.endsWith('/read')) {
    const idStr = p.slice('/api/message/'.length);
    const id = Number(idStr);
    const msg = messages.find((m) => m.id === id);
    if (!msg) return json(404, { error: 'Message not found' });
    return json(200, {
      description: msg.description,
      email: msg.email,
      messageid: msg.id,
      name: msg.name,
      phone: msg.phone,
      subject: msg.subject,
    });
  }

  if (method === 'PUT' && p.startsWith('/api/message/') && p.endsWith('/read')) {
    const idStr = p.slice('/api/message/'.length, p.length - '/read'.length - 1);
    const id = Number(idStr);
    const msg = messages.find((m) => m.id === id);
    if (!msg) return { status: 404, contentType: '', body: '' };
    msg.read = true;
    return { status: 202, contentType: '', body: '' };
  }

  if (method === 'POST' && p === '/api/message') {
    const data = tryParseJson(body);
    const errors = validateMessage(data);
    if (errors.length > 0) {
      return json(400, errors);
    }
    const newMsg = {
      id: nextMessageId++,
      name: data.name,
      email: data.email,
      phone: data.phone,
      subject: data.subject,
      description: data.description,
      read: false,
    };
    messages.push(newMsg);
    return json(200, { success: true });
  }

  // --- booking -------------------------------------------------------------
  if (method === 'POST' && p === '/api/booking') {
    const data = tryParseJson(body);
    const errors = validateBooking(data);
    if (errors.length > 0) {
      return json(400, { errors });
    }
    const newBooking = {
      bookingid: nextBookingId++,
      roomid: data.roomid,
      firstname: data.firstname,
      lastname: data.lastname,
      depositpaid: data.depositpaid,
      bookingdates: data.bookingdates,
      email: data.email,
      phone: data.phone,
    };
    bookings.push(newBooking);
    return json(200, { success: true });
  }

  // --- auth --------------------------------------------------------------
  if (method === 'POST' && p === '/api/auth/login') {
    const data = tryParseJson(body);
    const username = data.username ?? '';
    const password = data.password ?? '';
    if (username.trim() === '' || password.trim() === '') {
      return json(400, ['Username may not be blank', 'Password may not be blank']);
    }
    const token = deterministicToken(`${username}:${password}`);
    validTokens.add(token);
    return json(200, { token });
  }

  if (method === 'POST' && p === '/api/auth/validate') {
    const data = tryParseJson(body);
    const token = data.token ?? '';
    return json(200, { valid: validTokens.has(token) });
  }

  return null;
}

export default {
  reset() {
    seed();
  },
  handle,
};
