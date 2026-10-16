import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useState } from 'react';
import { useApi } from '../lib/useApi';

export function Header() {
  const { user, isAdmin, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const { data: site } = useApi<{ venue_name: string; logo_url: string }>('/site');
  const [logoFailed, setLogoFailed] = useState(false);

  const nav = (
    <>
      <NavItem to="/" label="Home" onClick={() => setOpen(false)} />
      <NavItem to="/resources" label="Resources" onClick={() => setOpen(false)} />
      <NavItem to="/availability" label="Availability" onClick={() => setOpen(false)} />
      {user ? (
        <>
          <NavItem to="/my-bookings" label="My Bookings" onClick={() => setOpen(false)} />
          <NavItem to="/organisations" label="Organisations" onClick={() => setOpen(false)} />
          <NavItem to="/account" label="My Account" onClick={() => setOpen(false)} />
          {isAdmin && <NavItem to="/admin" label="Admin" onClick={() => setOpen(false)} />}
          <button className="btn-secondary" onClick={() => { void logout(); setOpen(false); }}>
            Log out
          </button>
        </>
      ) : (
        <>
          <NavItem to="/login" label="Login" onClick={() => setOpen(false)} />
          <Link to="/register" className="btn-primary" onClick={() => setOpen(false)}>
            Register
          </Link>
        </>
      )}
    </>
  );

  return (
    <header className="bg-scout-purple text-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <Link to="/" className="flex items-center gap-3">
          {site?.logo_url && !logoFailed ? (
            <img src={site.logo_url} alt="" className="h-10 w-auto max-w-[10rem] object-contain" onError={() => setLogoFailed(true)} />
          ) : (
            <span className="grid h-10 w-10 place-items-center rounded-full bg-white text-scout-purple font-black">SS</span>
          )}
          <span className="text-lg font-extrabold leading-tight">Stratton Scouts<br /><span className="text-xs font-semibold opacity-80">Resource Booking</span></span>
        </Link>
        <nav className="hidden items-center gap-5 md:flex">{nav}</nav>
        <button
          className="md:hidden"
          aria-label="Toggle navigation"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
      </div>
      {open && <nav className="flex flex-col gap-3 px-4 pb-4 md:hidden">{nav}</nav>}
    </header>
  );
}

function NavItem({ to, label, onClick }: { to: string; label: string; onClick: () => void }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      onClick={onClick}
      className={({ isActive }) =>
        `font-bold hover:underline ${isActive ? 'underline underline-offset-4' : ''}`
      }
    >
      {label}
    </NavLink>
  );
}

export function Footer() {
  return (
    <footer className="mt-16 bg-scout-navy text-white">
      <div className="mx-auto max-w-6xl px-4 py-8 text-sm">
        <p className="font-bold">Stratton Scouts</p>
        <p className="mt-1 opacity-80">Hire our halls, kitchen, field and camping facilities for your group or event.</p>
        <p className="mt-4 opacity-60">
          We handle your data in line with UK GDPR. Contact details are used only to manage your bookings.
        </p>
      </div>
    </footer>
  );
}
