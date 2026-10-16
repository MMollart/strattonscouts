import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { visibleMenu, type AdminMenuGroup } from '../pages/admin/menu';

/** Admin sub-pages: a grouped sidebar of every admin page beside the page itself. */
export default function AdminLayout() {
  const { can } = useAuth();
  const menu = visibleMenu(can);
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);

  // Close the small-screen menu after moving to another page.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
      <aside className="mb-6 lg:mb-0">
        <button
          type="button"
          className="btn-secondary w-full lg:hidden"
          aria-expanded={open}
          aria-controls="admin-menu"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide admin menu' : 'Admin menu'}
        </button>
        <nav
          id="admin-menu"
          aria-label="Administration"
          className={`${open ? 'block' : 'hidden'} card mt-2 p-3 lg:sticky lg:top-4 lg:mt-0 lg:block lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto`}
        >
          <NavLink to="/admin" end className={linkClass}>Overview</NavLink>
          {menu.map((g) => <Group key={g.title} group={g} />)}
        </nav>
      </aside>
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}

function Group({ group }: { group: AdminMenuGroup }) {
  const id = `admin-menu-${group.title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <div className="mt-4">
      <p id={id} className="px-2 text-xs font-black uppercase tracking-wide text-gray-500">{group.title}</p>
      <ul aria-labelledby={id} className="mt-1 space-y-0.5">
        {group.items.map((i) => (
          <li key={i.to}>
            <NavLink to={i.to} end className={linkClass}>{i.label}</NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function linkClass({ isActive }: { isActive: boolean }) {
  return `block rounded-lg px-2 py-1.5 text-sm font-bold ${
    isActive ? 'bg-scout-purple text-white' : 'text-scout-purple hover:bg-scout-purple/10'
  }`;
}
