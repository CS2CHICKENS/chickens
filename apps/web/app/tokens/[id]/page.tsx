import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { config } from "../../../../../packages/core/src/index";
import { TokenDetail } from "../../../components/token-detail";

const ids = [
  ...config.tokens.map((token) => token.id),
  ...Object.keys(config.variantMeta),
];
export const dynamicParams = false;
export function generateStaticParams() {
  return ids.map((id) => ({ id }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const name = id.split("-").join(" ").toUpperCase();
  return {
    title: name,
    description:
      name +
      " token details, official address, market links and role in CS2 Chickens.",
    alternates: { canonical: "/tokens/" + id + "/" },
  };
}
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!ids.includes(id)) notFound();
  return <TokenDetail id={id} />;
}
