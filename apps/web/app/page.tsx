import { CreateRoomForm } from "@/components/create-room-form"

export default function Page() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="font-heading text-4xl font-medium tracking-tight">
          Rendezvous
        </h1>
        <p className="text-sm text-muted-foreground">
          Find the fairest place to meet in London
        </p>
      </div>
      <div className="w-full max-w-sm border border-border bg-background p-6">
        <CreateRoomForm />
      </div>
    </main>
  )
}
