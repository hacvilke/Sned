"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function CodeEntry() {
  const router = useRouter();
  const [value, setValue] = useState("");

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const code = value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 12);
    if (code.length < 4) return;
    router.push(`/d/${code}`);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="sr-only">Transfer code</span>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="ABC234"
          className="w-full rounded border border-line-strong bg-surface px-3 py-2.5 font-mono text-[18px] tracking-[0.3em] text-ink uppercase placeholder:text-faint/60"
        />
      </label>
      <button
        type="submit"
        disabled={value.replace(/[^A-Za-z0-9]/g, "").length < 4}
        className="w-full rounded bg-brand px-4 py-2.5 text-[14px] font-medium text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
      >
        Open transfer
      </button>
    </form>
  );
}
