import Link from "next/link";
import styles from "./participation.module.css";

export function Participation() {
  return (
    <section className={styles.panel} aria-labelledby="participation-title">
      <div className={styles.heading}>
        <span className="eyebrow">FIRST VISIT / THE ESSENTIALS</span>
        <h2 id="participation-title">
          TRADING SETS THE SCORE. HOLDING SETS YOUR SHARE.
        </h2>
      </div>
      <div className={styles.steps}>
        <article>
          <span className={styles.number}>01</span>
          <h3>FOLLOW A FAMILY</h3>
          <p>
            An original chicken and every launched variant compete together. All
            their trading volume adds to one family score.
          </p>
          <Link href="/inventory">EXPLORE THE CHICKENS ↗</Link>
        </article>
        <article>
          <span className={styles.number}>02</span>
          <h3>UNDERSTAND YOUR WEIGHT</h3>
          <p>
            Hatch-round rewards use eligible average holdings across the round.
            More personal trading does not directly mean a bigger reward.
          </p>
          <Link href="/whitepaper#7-who-gets-paid-and-how-much">
            HOW REWARDS WORK ↗
          </Link>
        </article>
        <article>
          <span className={styles.number}>03</span>
          <h3>CHECK YOUR WALLET</h3>
          <p>
            See your holdings and published payment records with a public
            address. Eligible payments are sent after operator settlement; no
            claim transaction is needed here.
          </p>
          <Link href="/check">CHECK MY WALLET ↗</Link>
        </article>
      </div>
      <p className={styles.note}>
        CHICK has a separate holder share in hatch rounds. EGG receives buybacks
        and burns. Timeout and fire rounds pay no holder rewards.{" "}
        <Link href="/verify">VERIFY A TOKEN ADDRESS ↗</Link>
      </p>
    </section>
  );
}
