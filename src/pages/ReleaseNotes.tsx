import { releaseNotes } from '../data/releaseNotes';

function formatDate(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function ReleaseNotes() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-3xl">What’s new</h1>
        <p className="mt-2 text-gray-600">A summary of the changes we’ve made to the booking website.</p>
      </div>
      {releaseNotes.map((note) => (
        <section key={`${note.date}-${note.title}`} className="card">
          <p className="text-sm font-bold text-scout-teal">{formatDate(note.date)}</p>
          <h2 className="mt-1 text-2xl">{note.title}</h2>
          {note.summary && <p className="mt-2 text-gray-600">{note.summary}</p>}
          <ul className="mt-4 list-disc space-y-2 pl-5">
            {note.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
