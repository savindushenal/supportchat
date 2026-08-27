import ChatWidget from "@/components/ChatWidget";

export default function Home() {
  return (
    <div className="relative min-h-screen bg-gradient-to-b from-slate-50 to-blue-50">
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-16">
        <p className="text-sm font-semibold uppercase tracking-wider text-blue-600">
          transexpress.lk
        </p>
        <h1 className="text-4xl font-bold tracking-tight text-slate-900">
          TransExpress
        </h1>
        <p className="text-xl font-medium text-slate-700">
          Fast, Reliable, Delivered with Care
        </p>
        <p className="max-w-xl text-lg leading-relaxed text-slate-600">
          Open the support agent for shipment help — senders and receivers can
          track, verify with SMS OTP for the full journey, request re-delivery,
          or reach customer care.
        </p>
        <ul className="mt-4 space-y-2 text-slate-600">
          <li className="flex items-start gap-2">
            <span className="mt-1 text-blue-500">✓</span>
            Track by waybill or phone (sender or receiver)
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 text-blue-500">✓</span>
            SMS OTP unlocks warehouse → dispatch → delivery timeline
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1 text-blue-500">✓</span>
            Re-delivery or human agent after verification
          </li>
        </ul>
        <p className="mt-8 text-sm text-slate-500">
          Customer Care: +94 112 999 888 / 0777-771 455
        </p>
      </main>

      <ChatWidget />
    </div>
  );
}
