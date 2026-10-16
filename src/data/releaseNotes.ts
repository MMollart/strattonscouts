// Release notes shown on /release-notes. Add new releases to the top of the list,
// written for the people who book and run the venue rather than for developers.

export interface ReleaseNote {
  title: string;
  date: string; // YYYY-MM-DD
  summary?: string;
  changes: string[];
}

export const releaseNotes: ReleaseNote[] = [
  {
    title: 'Release 3: audit history, maintenance, agreements and booking values',
    date: '2026-10-16',
    summary: 'Administrators can see who changed what, plan maintenance without double-booking the hall, and ask customers to accept the hire conditions.',
    changes: [
      'A full history of every booking and every change administrators make, with who made it, when, what changed and why.',
      'History is shown on each booking, organisation and resource, and can be searched and exported.',
      'Administrators can schedule maintenance on any resource. The resource can’t be booked while the work is on, and nor can anything it is part of.',
      'Existing bookings are never cancelled by maintenance. They are listed so an administrator can contact the group, and customers can be emailed a maintenance notice.',
      'Faults can be reported with a severity. Serious ones stop the resource being booked until they are fixed.',
      'Maintenance appears on the administrators’ calendar in orange stripes.',
      'When you book, you are shown any agreements for what you are booking, such as our hire conditions, and asked to tick to accept each one and type your name. You can also draw a signature.',
      'You can see the agreements you accepted, word for word, on each booking.',
      'If you change a booking to somewhere with different terms, you are asked to accept just the new ones.',
      'A new Booking values page shows administrators the value of confirmed, provisional, awaiting-approval and cancelled bookings for any period, by resource, price group and organisation, with a chart and a CSV download. These are booking values, not payments received.',
    ],
  },
  {
    title: 'Logo and branded emails',
    date: '2026-10-16',
    summary: 'The site and every email now look like Stratton Scouts.',
    changes: [
      'Every email we send uses the same Scouts-branded layout, with our logo at the top.',
      'Administrators can edit each email’s title, message, details box, thank-you line and footer without touching any HTML.',
      'The Scout Hut logo appears in the site header, at a larger size so it is easy to see.',
      'Clearer messages for administrators when the Office 365 email sign-in is refused.',
    ],
  },
  {
    title: 'Pricing, linked resources and filters',
    date: '2026-10-16',
    changes: [
      'Each resource has one full public price. Scouts and community groups get a percentage discount off it.',
      'Large photos are shrunk automatically when an administrator uploads them, so pages load quickly.',
      'Resources can be part of a larger one, for example a room within the hall. Booking the whole hall blocks its rooms for the same time, and the other way round.',
      'You can filter the resources list by group to find what you need faster.',
    ],
  },
  {
    title: 'Email, calendar and multi-resource bookings',
    date: '2026-10-15',
    changes: [
      'Booking emails are now sent from our Office 365 mailbox.',
      'The availability calendar greys out times that can’t be booked, such as outside opening hours.',
      'You can book several resources in one go. They are all booked together, or none are if any is unavailable.',
    ],
  },
  {
    title: 'Release 2: organisations and booking automation',
    date: '2026-10-15',
    changes: [
      'Organisations: set up your group, invite members and make bookings on its behalf.',
      'Prices can change from a set date, and organisations can have their own rates, discounts or free use.',
      'Availability rules per resource, such as opening hours, regular Scout meeting times, how much notice is needed and how far ahead you can book.',
      'Provisional bookings hold a slot for a limited time and are released automatically if not confirmed.',
      'Recurring bookings, for example every Tuesday evening for a term.',
      'View, change or cancel your own bookings online.',
      'Administrators can edit the emails we send and see a history of what was sent.',
      'One calendar showing every booking across all resources, for administrators.',
      'A register of keys, fobs and loaned equipment, showing who has each one, for administrators.',
      'Different administrator roles: Super Admin, Booking Admin and Viewer.',
    ],
  },
  {
    title: 'Release 1: online booking',
    date: '2026-10-15',
    summary: 'The first version of the Stratton Scouts booking website.',
    changes: [
      'Browse our halls, kitchen, field and camping facilities, with photos and prices.',
      'Check live availability on a calendar without needing an account.',
      'Register, log in and reset your password.',
      'Book online, including bookings that run over several days. Prices reflect whether you are Scouts, a community group or the public.',
      'Some resources need an administrator’s approval, and you get an email at each step.',
      'Administrators manage resources, prices, closures and approvals.',
    ],
  },
];
