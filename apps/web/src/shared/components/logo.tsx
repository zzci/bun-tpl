import { useId } from "react";
import { cn } from "@/shared/lib/utils";

interface LogoProps {
  className?: string;
}

/**
 * Shield-keyhole brand mark. Replace this component to rebrand.
 *
 * The gradient `id` is generated per instance via `useId()` so that
 * multiple `<Logo>` on the same page (e.g. one in the expanded sidebar
 * header, one in the collapsed toggle) don't collide. A literal id
 * would resolve to whichever copy mounted first — and if that copy is
 * inside a `display:none` subtree, browsers may refuse to resolve the
 * `url(#...)` reference, leaving the shield unfilled.
 */
export function Logo({ className }: LogoProps) {
  const reactId = useId();
  // CSS url() refs must be plain identifiers — React's `useId` returns
  // values containing colons (`:r0:`), so sanitize before use.
  const gradientId = `logo-g-${reactId.replace(/:/g, "")}`;
  return (
    <svg
      viewBox="0 0 128 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-6", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="16" y1="8" x2="112" y2="120" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="50%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#4338ca" />
        </linearGradient>
      </defs>
      <path
        d="M64 8L16 30v34c0 30.9 20.5 59.8 48 67 27.5-7.2 48-36.1 48-67V30L64 8z"
        fill={`url(#${gradientId})`}
      />
      <circle cx="64" cy="52" r="14" fill="#fff" fillOpacity=".95" />
      <path d="M56 60h16l-2 30H58L56 60z" fill="#fff" fillOpacity=".95" />
    </svg>
  );
}
