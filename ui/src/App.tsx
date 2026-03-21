import { APP_NAME } from "@paperclip-chat/shared";
import { MessageSquareText } from "lucide-react";

export function App() {
  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-950">
      <section className="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-6 py-16">
        <div className="w-full rounded-2xl border border-neutral-200 bg-white p-10 shadow-sm">
          <div className="mb-6 flex items-center gap-3">
            <div className="rounded-xl border border-neutral-200 bg-neutral-100 p-3">
              <MessageSquareText className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.2em] text-neutral-500">
                Monorepo Scaffold
              </p>
              <h1 className="text-3xl font-semibold tracking-tight">{APP_NAME}</h1>
            </div>
          </div>
          <p className="max-w-2xl text-base leading-7 text-neutral-600">
            Foundation for the Paperclip chat server, shared types package, and React UI.
          </p>
        </div>
      </section>
    </main>
  );
}
