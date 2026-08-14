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

  // How many days ahead the availability endpoint will look by default.
  horizonDays: 21,
};
