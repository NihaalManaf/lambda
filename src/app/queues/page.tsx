import QueueExplorer from "@/components/queues/QueueExplorer";

export const metadata = { title: "queues · lambda" };

export default function QueuesPage() {
  return (
    <main className="mx-auto min-w-0 max-w-7xl px-4 pb-24 pt-8 md:px-6 md:pt-10">
      <div className="mb-8">
        <div className="eyebrow mb-3">qstash · sqs · cron</div>
        <h1 className="display text-6xl md:text-7xl">
          queues<span className="outlined">.</span>
        </h1>
      </div>
      <QueueExplorer />
    </main>
  );
}
