import { Suspense } from "react";
import KioskDisplayView from "./kiosk-display-view";

export default function KioskDisplayPage() {
  return (
    <Suspense fallback={<div className="flex h-screen w-screen items-center justify-center bg-[#0b0f14]" />}>
      <KioskDisplayView />
    </Suspense>
  );
}
