import type { Metadata } from "next";
import { DataStatus } from "../../components/data-status";
export const metadata: Metadata = {
  title: "Data & payments",
  description:
    "Check published data freshness, fee coverage and payment verification for CS2 Chickens.",
};
export default function Page() {
  return <DataStatus />;
}
