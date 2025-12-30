import { Suspense } from "react";
import Logos from "@/components/logos";

export default function Home() {
  return (
    <div>
      <p>page.tsx</p>
      <Suspense fallback={<div>Loading logos…</div>}>
        <Logos />
      </Suspense>
    </div>
  );
}
