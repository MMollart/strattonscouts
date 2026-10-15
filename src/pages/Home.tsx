import { Link } from 'react-router-dom';

export default function Home() {
  return (
    <div className="space-y-12">
      <section className="rounded-3xl bg-gradient-to-br from-scout-purple to-scout-purple-dark px-6 py-16 text-white md:px-12">
        <h1 className="text-4xl leading-tight md:text-5xl">Book Stratton Scouts facilities for your group or event</h1>
        <p className="mt-4 max-w-2xl text-lg opacity-90">
          Our halls, kitchen, event field and camping are available to hire — for Scouts, community
          organisations and the general public. Check availability and book online in minutes.
        </p>
        <div className="mt-8 flex flex-wrap gap-4">
          <Link to="/availability" className="btn bg-white text-scout-purple hover:bg-scout-off-white">
            Check availability
          </Link>
          <Link to="/resources" className="btn border-2 border-white text-white hover:bg-white/10">
            Explore resources
          </Link>
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-3">
        <Feature title="See real-time availability" body="View an interactive calendar and find the perfect slot for your group — no account needed." />
        <Feature title="Fair, transparent pricing" body="Prices automatically reflect your category: Scouts, community organisations or the public." />
        <Feature title="Simple, secure booking" body="Register, choose your dates and book. We handle approvals and send you confirmation by email." />
      </section>

      <section className="card">
        <h2 className="text-2xl">How it works</h2>
        <ol className="mt-4 grid gap-4 md:grid-cols-4">
          {['Choose a resource', 'Check availability', 'Register or log in', 'Confirm your booking'].map((step, i) => (
            <li key={step} className="rounded-xl bg-scout-off-white p-4">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-scout-teal font-black text-white">{i + 1}</span>
              <p className="mt-2 font-bold">{step}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="card">
      <h3 className="text-lg text-scout-purple">{title}</h3>
      <p className="mt-2 text-gray-600">{body}</p>
    </div>
  );
}
