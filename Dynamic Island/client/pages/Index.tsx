import DynamicIsland from "@/components/dynamic-island/DynamicIsland";

export default function Index() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(120%_120%_at_50%_0%,#2b2b30_0%,#0a0a0c_55%,#000_100%)] px-4 py-16">
      <DynamicIsland toggleOnClick placement="top" />
    </div>
  );
}
