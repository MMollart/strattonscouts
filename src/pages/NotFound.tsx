import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md text-center">
      <p className="text-6xl font-black text-scout-purple">404</p>
      <h1 className="mt-4 text-3xl">Page not found</h1>
      <p className="mt-2 text-gray-600">Sorry, we couldn't find the page you were looking for.</p>
      <Link to="/" className="btn-primary mt-6 inline-block">Back to home</Link>
    </div>
  );
}
