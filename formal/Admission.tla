--------------------------- MODULE Admission ---------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS Deliveries, Digests, None,
          SkipSourceGate, OverwriteConflict, DuplicateReplay
ASSUME /\ Deliveries # {} /\ Digests # {} /\ None \notin Digests
       /\ SkipSourceGate \in BOOLEAN /\ OverwriteConflict \in BOOLEAN
       /\ DuplicateReplay \in BOOLEAN

VARIABLES phase, request, ledger, firstDigest, admissions, safe
vars == <<phase, request, ledger, firstDigest, admissions, safe>>
Requests == [delivery : Deliveries, digest : Digests,
             sourceComplete : BOOLEAN, bindingMatches : BOOLEAN,
             agentComplete : BOOLEAN]
Eligible(r) == r.sourceComplete /\ r.bindingMatches /\ r.agentComplete

Init == /\ phase = "idle"
        /\ request = CHOOSE r \in Requests : TRUE
        /\ ledger = [d \in Deliveries |-> None]
        /\ firstDigest = [d \in Deliveries |-> None]
        /\ admissions = [d \in Deliveries |-> 0]
        /\ safe = [d \in Deliveries |-> TRUE]

\* The request is an owned immutable copy. Complete acquisition and final
\* identity/snapshot validation are abstracted by sourceComplete/bindingMatches.
Begin == /\ phase = "idle"
         /\ \E r \in Requests : request' = r
         /\ phase' = "acquired"
         /\ UNCHANGED <<ledger, firstDigest, admissions, safe>>

Reject == /\ phase = "acquired"
          /\ ~Eligible(request) /\ ~SkipSourceGate
          /\ phase' = "idle"
          /\ UNCHANGED <<request, ledger, firstDigest, admissions, safe>>

\* All durable writes are one atomic SQLite transaction. Delivery is the
\* abstract tuple (target, attempt, snapshot, scope), digest is request content.
Admit == LET d == request.delivery IN
         /\ phase = "acquired"
         /\ Eligible(request) \/ SkipSourceGate
         /\ ledger[d] = None
         /\ ledger' = [ledger EXCEPT ![d] = request.digest]
         /\ firstDigest' = [firstDigest EXCEPT ![d] = request.digest]
         /\ admissions' = [admissions EXCEPT ![d] = 1]
         /\ safe' = [safe EXCEPT ![d] = Eligible(request)]
         /\ phase' = "committed"
         /\ UNCHANGED request

Replay == LET d == request.delivery IN
          /\ phase = "acquired"
          /\ Eligible(request) \/ SkipSourceGate
          /\ ledger[d] = request.digest
          /\ admissions' = IF DuplicateReplay
                           THEN [admissions EXCEPT ![d] = 2]
                           ELSE admissions
          /\ phase' = "committed"
          /\ UNCHANGED <<request, ledger, firstDigest, safe>>

Conflict == LET d == request.delivery IN
            /\ phase = "acquired"
            /\ Eligible(request) \/ SkipSourceGate
            /\ ledger[d] # None /\ ledger[d] # request.digest
            /\ ledger' = IF OverwriteConflict
                         THEN [ledger EXCEPT ![d] = request.digest]
                         ELSE ledger
            /\ phase' = "idle"
            /\ UNCHANGED <<request, firstDigest, admissions, safe>>

\* Completion, interruption or process restart loses volatile progress only.
\* A crash after commit does not undo admission; replay must observe it.
Reset == /\ phase \in {"acquired", "committed"}
         /\ phase' = "idle"
         /\ UNCHANGED <<request, ledger, firstDigest, admissions, safe>>

Next == Begin \/ Reject \/ Admit \/ Replay \/ Conflict \/ Reset
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"idle", "acquired", "committed"}
          /\ request \in Requests
          /\ ledger \in [Deliveries -> Digests \cup {None}]
          /\ firstDigest \in [Deliveries -> Digests \cup {None}]
          /\ admissions \in [Deliveries -> 0..2]
          /\ safe \in [Deliveries -> BOOLEAN]
NoInvalidAdmission == \A d \in Deliveries : ledger[d] # None => safe[d]
NoConflictOverwrite == \A d \in Deliveries : ledger[d] = firstDigest[d]
NoDuplicateAdmission == \A d \in Deliveries : admissions[d] <= 1
=======================================================================
