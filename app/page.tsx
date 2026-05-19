import Image from "next/image";
import Link from "next/link";
import { PPP_BRAND } from "@/lib/brand";

export default function LoginLanding() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 relative overflow-hidden">
      {/* Brand gradient backdrop */}
      <div className="absolute inset-0 -z-10 bg-gradient-to-br from-ppp-blue-50 via-white to-ppp-orange-50" />
      <div className="absolute -top-32 -right-32 -z-10 h-96 w-96 rounded-full bg-ppp-blue/10 blur-3xl" />
      <div className="absolute -bottom-32 -left-32 -z-10 h-96 w-96 rounded-full bg-ppp-orange/10 blur-3xl" />

      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-ppp-charcoal-100 p-10">
        <div className="flex justify-center mb-8">
          <Image
            src="/brand/logo.svg"
            alt={PPP_BRAND.name}
            width={240}
            height={80}
            priority
          />
        </div>

        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-ppp-charcoal tracking-tight">
            Command Center
          </h1>
          <p className="mt-2 text-sm text-ppp-charcoal-500">
            Internal operations platform · sign in to continue
          </p>
        </div>

        <Link
          href="/dashboard"
          className="w-full inline-flex items-center justify-center gap-3 bg-ppp-blue text-white font-medium py-3 px-4 rounded-lg hover:bg-ppp-blue-600 active:bg-ppp-blue-700 transition-colors shadow-sm shadow-ppp-blue/30"
        >
          <GoogleIcon />
          Sign in with Google
        </Link>

        <div className="mt-6 text-center text-xs text-ppp-charcoal-500">
          PPP staff only. Access controlled by your Google Workspace account.
        </div>
      </div>

      <p className="mt-8 text-xs text-ppp-charcoal-500 text-center">
        {PPP_BRAND.name} · {PPP_BRAND.tagline}
      </p>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}
