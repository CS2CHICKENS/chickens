import type { Metadata } from "next";
import { TokenVerifier } from "../../components/token-verifier";

export const metadata: Metadata = {
  title: "Check a token",
  description:
    "Compare a contract address with the published CS2 Chickens tokens on Robinhood Chain.",
  alternates: { canonical: "/verify/" },
};

export default function Page() {
  return <TokenVerifier />;
}
