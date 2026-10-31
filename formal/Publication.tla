-------------------------- MODULE Publication --------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Intents, Workers, Bodies, Comments, None,
          SkipReservation, RetryUnknown, AcceptSpoof
ASSUME /\ Intents # {} /\ Workers # {} /\ Bodies # {} /\ Comments # {}
       /\ None \notin Bodies /\ None \notin Comments

VARIABLES state, body, firstBody, permit, posts, delivered, reference,
          firstReference, authorized, postWasReserved, trustedAck
vars == <<state, body, firstBody, permit, posts, delivered, reference,
          firstReference, authorized, postWasReserved, trustedAck>>

Init == /\ state = [i \in Intents |-> "pending"]
        /\ body = [i \in Intents |-> None]
        /\ firstBody = body
        /\ permit = [w \in Workers |-> None]
        /\ posts = [i \in Intents |-> 0]
        /\ delivered = [i \in Intents |-> None]
        /\ reference = [i \in Intents |-> None]
        /\ firstReference = reference
        /\ authorized = [i \in Intents |-> FALSE]
        /\ postWasReserved = [i \in Intents |-> TRUE]
        /\ trustedAck = [i \in Intents |-> TRUE]

\* One immediate transaction wins. Eligibility abstracts an explicit unexpired
\* authority, matching trusted lease and fresh evidence for this exact binding.
Reserve(i, w, b, eligible) ==
  /\ state[i] = "pending" /\ permit[w] = None /\ eligible
  /\ ~\E other \in Workers : permit[other] = i
  /\ state' = [state EXCEPT ![i] = "sending"]
  /\ body' = [body EXCEPT ![i] = b]
  /\ firstBody' = [firstBody EXCEPT ![i] = b]
  /\ authorized' = [authorized EXCEPT ![i] = eligible]
  /\ permit' = [permit EXCEPT ![w] = i]
  /\ UNCHANGED <<posts, delivered, reference, firstReference,
                  postWasReserved, trustedAck>>

\* A deliberately broken pre-reservation path must fail the corresponding
\* invariant, even if no remote comment ultimately appears.
Unreserved(i, w) ==
  /\ SkipReservation /\ state[i] = "pending" /\ permit[w] = None
  /\ ~\E other \in Workers : permit[other] = i
  /\ permit' = [permit EXCEPT ![w] = i]
  /\ UNCHANGED <<state, body, firstBody, posts, delivered, reference,
                  firstReference, authorized, postWasReserved, trustedAck>>

\* The sole volatile permit is consumed before awaiting any response. Both a
\* lost response after delivery and failure before delivery are possible.
Post(i, w, outcome) ==
  /\ permit[w] = i /\ posts[i] < 2
  /\ posts' = [posts EXCEPT ![i] = @ + 1]
  /\ delivered' = [delivered EXCEPT ![i] = outcome]
  /\ postWasReserved' = [postWasReserved EXCEPT
                          ![i] = @ /\ state[i] = "sending" /\ authorized[i]]
  /\ permit' = [permit EXCEPT ![w] = None]
  /\ UNCHANGED <<state, body, firstBody, reference, firstReference,
                  authorized, trustedAck>>

Crash(w) == /\ permit[w] # None
            /\ permit' = [permit EXCEPT ![w] = None]
            /\ UNCHANGED <<state, body, firstBody, posts, delivered, reference,
                            firstReference, authorized, postWasReserved, trustedAck>>

Unknown(i) ==
  /\ state[i] = "sending"
  /\ ~\E w \in Workers : permit[w] = i
  /\ state' = [state EXCEPT ![i] = "unknown"]
  /\ UNCHANGED <<body, firstBody, permit, posts, delivered, reference,
                  firstReference, authorized, postWasReserved, trustedAck>>

\* Unsafe recovery takeover is a negative control, never the intended design.
Retry(i, w) ==
  /\ RetryUnknown /\ state[i] = "unknown" /\ permit[w] = None
  /\ posts[i] < 2
  /\ state' = [state EXCEPT ![i] = "sending"]
  /\ permit' = [permit EXCEPT ![w] = i]
  /\ UNCHANGED <<body, firstBody, posts, delivered, reference, firstReference,
                  authorized, postWasReserved, trustedAck>>

\* Exact positive represents one unambiguous canonical target + numeric bot +
\* exact frozen body match. A marker, zero matches or duplicate matches is false.
Acknowledge(i, c, exactPositive) ==
  /\ state[i] \in {"sending", "unknown"}
  /\ (exactPositive /\ delivered[i] = c) \/ AcceptSpoof
  /\ state' = [state EXCEPT ![i] = "acknowledged"]
  /\ reference' = [reference EXCEPT ![i] = c]
  /\ firstReference' = [firstReference EXCEPT ![i] = c]
  /\ trustedAck' = [trustedAck EXCEPT ![i] = exactPositive /\ delivered[i] = c]
  /\ UNCHANGED <<body, firstBody, permit, posts, delivered,
                  authorized, postWasReserved>>

\* A repeated same-ID acknowledgement and inconclusive reads are stuttering.
Next == (\E i \in Intents, w \in Workers, b \in Bodies, e \in BOOLEAN : Reserve(i,w,b,e))
     \/ (\E i \in Intents, w \in Workers : Unreserved(i,w) \/ Retry(i,w))
     \/ (\E i \in Intents, w \in Workers, c \in Comments \cup {None} : Post(i,w,c))
     \/ (\E w \in Workers : Crash(w))
     \/ (\E i \in Intents : Unknown(i))
     \/ (\E i \in Intents, c \in Comments, e \in BOOLEAN : Acknowledge(i,c,e))
     \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars

TypeOK == /\ state \in [Intents -> {"pending", "sending", "unknown", "acknowledged"}]
          /\ body \in [Intents -> Bodies \cup {None}]
          /\ firstBody \in [Intents -> Bodies \cup {None}]
          /\ permit \in [Workers -> Intents \cup {None}]
          /\ posts \in [Intents -> 0..2]
          /\ delivered \in [Intents -> Comments \cup {None}]
          /\ reference \in [Intents -> Comments \cup {None}]
          /\ firstReference \in [Intents -> Comments \cup {None}]
          /\ authorized \in [Intents -> BOOLEAN]
          /\ postWasReserved \in [Intents -> BOOLEAN]
          /\ trustedAck \in [Intents -> BOOLEAN]
ReservedBeforePost == \A i \in Intents : postWasReserved[i]
AtMostOnePost == \A i \in Intents : posts[i] <= 1
TrustedAcknowledgement == \A i \in Intents : trustedAck[i]
FrozenIdentity == /\ body = firstBody /\ reference = firstReference
UniqueWinner == \A i \in Intents : Cardinality({w \in Workers : permit[w] = i}) <= 1
=======================================================================
