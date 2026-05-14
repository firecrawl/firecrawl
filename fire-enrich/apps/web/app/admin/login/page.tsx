import { LoginForm } from './login-form';

export const metadata = {
  title: 'Admin login · Fire Enrich',
};

export default function AdminLoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background-base px-4">
      <LoginForm />
    </div>
  );
}
