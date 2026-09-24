import { LinkArrow } from "../components/link-arrow";
import Link from "next/link";
export default function NotFound() {
  return (
    <div className="page">
      <span className="eyebrow">404 / OFF THE MAP</span>
      <h1>POSITION UNKNOWN.</h1>
      <Link className="button primary" href="/">
        RETURN TO PLAY <LinkArrow />
      </Link>
    </div>
  );
}
