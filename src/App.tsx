import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Header, Footer } from './components/Layout';
import { useAuth } from './lib/auth';
import { Spinner } from './components/ui';

import Home from './pages/Home';
import Resources from './pages/Resources';
import ResourceDetails from './pages/ResourceDetails';
import Availability from './pages/Availability';
import Register from './pages/Register';
import Login from './pages/Login';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Account from './pages/Account';
import MyBookings from './pages/MyBookings';
import BookingDetails from './pages/BookingDetails';
import BookResource from './pages/BookResource';
import AdminDashboard from './pages/admin/Dashboard';
import AdminResources from './pages/admin/Resources';
import AdminBookings from './pages/admin/Bookings';
import AdminUsers from './pages/admin/Users';
import AdminPricing from './pages/admin/Pricing';
import NotFound from './pages/NotFound';

function RequireAuth({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { user, loading, isAdmin } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (admin && !isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:bg-white focus:p-2">Skip to content</a>
      <Header />
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/resources" element={<Resources />} />
          <Route path="/resources/:slug" element={<ResourceDetails />} />
          <Route path="/availability" element={<Availability />} />
          <Route path="/register" element={<Register />} />
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />

          <Route path="/book/:slug" element={<RequireAuth><BookResource /></RequireAuth>} />
          <Route path="/account" element={<RequireAuth><Account /></RequireAuth>} />
          <Route path="/my-bookings" element={<RequireAuth><MyBookings /></RequireAuth>} />
          <Route path="/bookings/:id" element={<RequireAuth><BookingDetails /></RequireAuth>} />

          <Route path="/admin" element={<RequireAuth admin><AdminDashboard /></RequireAuth>} />
          <Route path="/admin/resources" element={<RequireAuth admin><AdminResources /></RequireAuth>} />
          <Route path="/admin/bookings" element={<RequireAuth admin><AdminBookings /></RequireAuth>} />
          <Route path="/admin/users" element={<RequireAuth admin><AdminUsers /></RequireAuth>} />
          <Route path="/admin/pricing" element={<RequireAuth admin><AdminPricing /></RequireAuth>} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
}
