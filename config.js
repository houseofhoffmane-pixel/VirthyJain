// ---------------------------------------------------------------------------
// Everything you'd normally want to change lives here. Edit this file, commit,
// redeploy. No database or code changes needed for services, prices, or hours.
// Times are Irish local time (Europe/Dublin). weekday: 0=Sun … 6=Sat.
// ---------------------------------------------------------------------------

// Helper: the same opening windows Monday–Friday.
const monToFri = (windows) => ({ 1: windows, 2: windows, 3: windows, 4: windows, 5: windows });

module.exports = {
  timezone: 'Europe/Dublin',

  services: [
    { id: 1, name: 'Initial assessment',        duration: 55, price: 70 },
    { id: 2, name: 'Return visit',              duration: 40, price: 55 },
    { id: 3, name: "Women's health",            duration: 50, price: 70 },
    { id: 4, name: 'Sports and return-to-play', duration: 50, price: 65 },
  ],

  formats: [
    { key: 'clinic',     name: 'Clinic in Dublin' },
    { key: 'home',       name: 'Home visit' },
    { key: 'telehealth', name: 'Telehealth' },
  ],

  // Weekly opening hours per format. Each entry is a list of [open, close]
  // windows for that weekday. An appointment (plus its duration) must finish
  // by the close time.
  hours: {
    clinic:     monToFri([['08:00', '11:45'], ['14:00', '17:45']]),
    home:       monToFri([['14:00', '19:15']]),
    telehealth: monToFri([['08:00', '11:45'], ['18:30', '20:15']]),
  },

  slotStepMinutes: 15,   // spacing of offered start times
  bufferMinutes: 10,     // gap left between two appointments
  homeTravelMinutes: 30, // extra gap around a home visit
  minNoticeHours: 12,    // can't book inside the next 12 hours
  cancelCutoffHours: 12, // can't cancel inside 12 hours of the appointment
  reminderHours: 24,     // send an email reminder this long before the appointment

  // How many days ahead the availability endpoint will look by default.
  horizonDays: 21,

  // Practice details — shown on receipts (for insurance / Revenue claims).
  practice: {
    name: 'Virthy Jain Physiotherapy',
    coruReg: process.env.CORU_REG || '',   // e.g. "PT012345" — set your CORU reg no.
    phone: process.env.PRACTITIONER_PHONE || '+353 87 706 5821',
    email: process.env.PRACTITIONER_EMAIL || 'virtee9808@gmail.com',
    address: process.env.PRACTICE_ADDRESS || 'Dublin, Ireland',
  },

  // Outcome measures recorded per session (numbers). Edit freely; each becomes
  // an input on the session note and a line on the patient's progress chart.
  outcomes: [
    { id: 'pain', label: 'Pain (0–10)', min: 0, max: 10 },
    { id: 'rom', label: 'Range of motion (°)', min: 0, max: 180 },
    { id: 'function', label: 'Function (0–100)', min: 0, max: 100 },
  ],

  // Digital intake + consent form. Add/edit fields here anytime (no code
  // changes). types: text | textarea | date | tel | select | yesno.
  intake: {
    consentVersion: 'v1',
    fields: [
      { id: 'dob', label: 'Date of birth', type: 'date' },
      { id: 'address', label: 'Address', type: 'textarea' },
      { id: 'gp', label: 'GP name / practice', type: 'text' },
      { id: 'emergency', label: 'Emergency contact (name & phone)', type: 'text' },
      { id: 'complaint', label: 'What are you coming in for?', type: 'textarea' },
      { id: 'duration', label: 'How long has it been going on?', type: 'text' },
      { id: 'history', label: 'Relevant medical history / conditions', type: 'textarea' },
      { id: 'medications', label: 'Current medications', type: 'textarea' },
      { id: 'allergies', label: 'Allergies', type: 'text' },
      { id: 'surgeries', label: 'Previous surgeries or injuries', type: 'textarea' },
      { id: 'goal', label: 'Your goal for treatment', type: 'text' },
      // Add your screening questions later, e.g.:
      // { id: 'weightloss', label: 'Any unexplained weight loss?', type: 'yesno' },
    ],
    consents: [
      { id: 'treatment', text: 'I consent to physiotherapy assessment and treatment by Virthy Jain, and confirm the information above is accurate to the best of my knowledge.' },
      { id: 'gdpr', text: 'I consent to my personal and health information being stored and processed for my care, in line with GDPR. I understand I can request access to, or erasure of, my data at any time.' },
    ],
  },
};
