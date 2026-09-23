import { Inventory } from "../../../components/inventory";
export function generateStaticParams() {
  return ["catalana", "polish", "silkie"].map((family) => ({ family }));
}
export default async function Page({
  params,
}: {
  params: Promise<{ family: string }>;
}) {
  return <Inventory family={(await params).family} />;
}
