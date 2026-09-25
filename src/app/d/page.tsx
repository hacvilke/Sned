import { CodeEntry } from "@/components/CodeEntry";

export const metadata = { title: "Open a transfer" };

export default function CodeEntryPage() {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-14 sm:px-6">
      <h1 className="text-[22px] font-semibold tracking-tight text-ink">Open a transfer</h1>
      <p className="mt-2 text-[14px] text-muted">
        Enter the code from the sender&apos;s screen.
      </p>
      <div className="mt-6">
        <CodeEntry />
      </div>
      <p className="mt-6 text-[13px] text-muted">
        <a href="/" className="text-brand underline underline-offset-2 hover:text-brand-dark">
          Send files instead
        </a>
      </p>
    </div>
  );
}
