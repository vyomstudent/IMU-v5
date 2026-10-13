# MISSION: Transform VSPIMU into a Research-Grade Health Intelligence System and AI Personal Companion

## YOUR ROLE

Act as a coordinated team of world-class experts:

- Biomedical engineers and wearable-sensing researchers
- Neurologists, geriatricians, physiotherapists, and rehabilitation specialists
- Biomechanics and gait-analysis scientists
- Clinical AI and evidence-based medicine researchers
- Signal-processing, machine-learning, and sensor-fusion engineers
- Human-centered AI and conversational companion designers
- Android, MIT App Inventor, JavaScript, and embedded-systems engineers
- Privacy, medical-device safety, and validation specialists

**Your mission is to push this project as far as scientifically, technically, creatively, and practically possible.**

Do not give me a generic list of ideas. Perform serious research, inspect existing implementations, challenge assumptions, compare competing methods, identify unexplored opportunities, and develop a detailed, feasible architecture.

Use the maximum reasoning, research, experimentation, and available resources justified by the complexity of this project.

The ambition is extremely high: create one of the most useful personalized mobility and health-intelligence experiences achievable with inexpensive wearable sensors.

Clinical credibility must come from validation, traceability, calibrated uncertainty, and clearly established limitations—not from exaggerated claims.

---

# 1. UNDERSTAND MY EXISTING PROJECT FIRST

Project: **VSPIMU — Wearable Gait and Mobility Assessment**

GitHub repository:
https://github.com/vyomstudent/IMU-v5

Current dual-IMU implementation:
https://github.com/vyomstudent/IMU-v5/tree/main/VSPIMU_V6_DualIMU_Implementation_Bundle

Reference implementation:
https://github.com/vyomstudent/IMU-v5/tree/main/VSPIMU_V5_8_12_PARITY_REPORT_FIXED_FINAL

Current development status: V6.1.3 dual-IMU prototype. Its asset patcher has passed 20/20 synthetic regression tests, but the full Android/App Inventor sensor and BLE integration still requires physical-device validation.

The GitHub repository's main branch may not contain the latest locally patched V6.1.3 files. Account for this difference and obtain the latest local bundle if required. Do not assume missing files or unverified integrations are complete.

### Current hardware

**Primary IMU:**
- LSM6DSO mounted on the lower/distal tibia
- Placement fixed approximately 4–5 cm above the medial malleolus, anterior/anteromedial surface
- Secure, repeatable mounting and sensor-axis orientation
- ESP32-based wearable
- Nominal 208 Hz acquisition
- Accelerometer and gyroscope, six axes total
- BLE transmission to Android
- Existing raw-sample protocol and BLE characteristics must remain compatible

**Secondary IMU:**
- Android smartphone accelerometer and gyroscope
- Phone placed consistently in a front trouser pocket
- Same-leg or opposite-leg placement selectable and documented
- Accelerometer and gyro are collected using MIT App Inventor native components and forwarded to the WebViewer
- Phone sampling rates and callback timing are device-dependent
- Android accelerometer callbacks currently lack original hardware event timestamps in the AI2 interface
- Cross-sensor synchronization is exploratory, not proven millisecond-accurate

**Additional smartphone sensors that MAY be investigated now:**
- Barometer
- GPS/GNSS outdoors
- Other genuinely available Android sensors, where their use is justified

Do not assume these sensors exist or provide measurements they cannot support.

**Future hardware, NOT currently available:**
- MAX30102-based optical pulse sensing
- TMP117 temperature sensor
- Other sensors selected after research

Do not assume a future MAX30102 system can measure clinically reliable HRV, SpO₂, sleep stages, or physiological stress without suitable acquisition, placement, algorithms, and validation.

### Current software

- MIT App Inventor Android application
- WebViewer containing HTML/JavaScript analytics, UI, diagnostics, and reports
- Existing TCN, wavelet, AFO, gait-event detection and retrospective analysis
- Standardized approximately 123-second assessment protocol
- BLE shank acquisition plus optional phone IMU stream
- Session report, local analysis, data-quality evaluation and CSV/JSON export
- No cloud inference dependency required for the current gait pipeline
- Inertia-1 intentionally removed
- Aim to minimize native App Inventor blocks

Read and audit the real code, documentation, tests, and existing report. Do not redesign the system based on assumptions without examining what is already implemented.

Preserve what works and explain changes that materially improve accuracy, reliability, or usefulness.

---

# 2. OUR ULTIMATE VISION

Develop **VSPIMU Health Intelligence + Personal Companion**.

Instead of merely showing heart rate, gait parameters, and activity statistics, the system should connect:

**Objective movement → physiological context → personal history → self-reported symptoms → plausible explanations → appropriate actions → follow-up outcomes.**

For example, imagine that future validated physiological sensing identifies an unusual resting-HR trend, while the gait wearable identifies worsening stride-time variability and the person reports poor sleep.

The system should intelligently consider multiple possibilities, ask relevant follow-up questions, and determine what further evidence would be useful.

It should distinguish between:
1. Directly measured facts
2. Derived and validated estimates
3. Statistical associations
4. Plausible but unconfirmed explanations
5. Findings that require professional medical evaluation

Never turn a correlation into an unsupported diagnosis.

**The companion becomes the primary conversational interface; a powerful evidence-based analysis engine provides the information behind it.**

---

# 3. RESEARCH THE MAXIMUM INFORMATION EXTRACTABLE FROM OUR CURRENT SENSORS

Investigate every meaningful and defensible feature that can be derived from:

- One lower-shank six-axis IMU
- One smartphone six-axis IMU in the front pocket
- Optional phone barometer/GPS where useful
- User-reported observations
- Repeated standardized measurements

Go far beyond simple cadence and step count.

Research:

### Gait and locomotion
- Initial contact and final contact detection
- Step and stride timing
- Cadence
- Stance and swing duration
- Temporal variability and irregularity
- Walking-bout quality and consistency
- Acceleration/deceleration patterns
- Shuffling-like motion features
- Turning and movement transitions
- Stop-start behavior
- Motion smoothness, symmetry-related proxy features where supportable
- Signal regularity, harmonicity and periodicity
- Potential gait hesitations
- Fatigue-related changes across a session
- Movement behavior relative to personal baseline
- Gait quality under different walking conditions
- Research-only tremor and freezing-of-gait candidate indicators

### Mobility and functional movement
- Sit-to-stand and stand-to-sit transitions when the protocol can capture them reliably
- Turning duration and quality
- Postural transitions
- Functional mobility proxies
- Movement initiation and termination
- Rest-versus-movement differentiation
- Longer-term mobility changes
- Candidate instability indicators
- Unusual deviations from an individual's normal pattern

### Signals and mathematics
Investigate wavelets, TCNs, AFOs, adaptive filtering, periodicity analysis, spectral entropy, autocorrelation, nonlinear measures, statistical change-point detection, uncertainty quantification, sensor-fusion models, and other appropriate methods.

For every candidate metric, determine:

- Can it actually be estimated with these sensors?
- What assumptions are required?
- Which placement and orientation conditions matter?
- What algorithm is best supported by research?
- How accurate is it in published independent validation?
- Can we reproduce or validate that accuracy?
- How computationally expensive is it?
- Does it provide meaningful information beyond existing metrics?
- Should it be included in a clinical-facing report?
- When should the system suppress the result because of poor data?

**Critical:** Do not fabricate millimetre foot clearance, exact hip/knee flexion angles, absolute gait speed, true bilateral gait asymmetry, or medically validated fall-risk probabilities from our current sensor placement alone. Research whether any of these can be approximated under specific calibration or additional-data conditions, and label such results appropriately.

Produce a comprehensive metric feasibility matrix.

---

# 4. DESIGN A MUCH MORE INTELLIGENT REPORT

I want the report transformed from a measurement dashboard into a **personalized, actionable mobility and health assessment**.

Design two connected layers:

**A. User-friendly interpretation**
- What looks normal for this person's own baseline?
- What changed?
- How large or persistent is the change?
- Why might it matter for daily function?
- What can the user reasonably do next?
- Which findings require attention?
- What questions should the companion ask?

**B. Clinician-facing evidence**
- Raw and derived metrics with units
- Analysis method and model version
- Sensor position and acquisition quality
- Confidence intervals or appropriate uncertainty estimates
- Personal-baseline comparison
- Validated reference comparisons where available
- Session reproducibility and reliability
- Evidence supporting interpretations
- Candidate explanations and competing explanations
- Relevant user-reported symptoms
- Longitudinal plots
- Clear limitations and unverified results
- Suggested clinical follow-up questions

Research clinically recognized frameworks, such as gait variability, functional mobility assessments, and geriatric mobility screening, but do not claim a standardized clinical test was performed unless our actual protocol satisfies its requirements.

I want the report to explain the **meaning of the measurements**, not simply display numbers.

Design a report that a clinician could audit and that an older adult could understand without specialized technical knowledge.

---

# 5. BUILD AN EVIDENCE-BASED INFERENCE ENGINE

Develop a structured, explainable system that connects the sensor evidence with functional changes and contextual information.

Example:

**Observed evidence:** A person's stride-time variability rises significantly over repeated valid sessions.

**Potential explanations to investigate:** Changes in fatigue, pain, footwear, medication, walking surface, walking aid, illness, recording conditions, or neurological/musculoskeletal function.

**Next action:** Identify the most informative questions and determine whether repeat measurement, non-urgent clinical review, or a more urgent assessment is appropriate.

The system must never automatically select one explanation as the diagnosis.

Research Bayesian approaches, interpretable probabilistic models, causal reasoning limitations, longitudinal anomaly detection, rule-based clinical safety layers, and calibrated machine-learning models.

Create an **evidence-to-inference-to-action framework**.

Every important inference should include:
- Supporting observations
- Alternative explanations
- Evidence strength
- Confidence and uncertainty
- Missing information
- User-reported context
- Appropriate next steps
- Whether medical evaluation is necessary

Research the safest and most useful way to communicate uncertainty without overwhelming elderly users.

---

# 6. DESIGN AN INTELLIGENT FOLLOW-UP QUESTION SYSTEM

Do not use one fixed health questionnaire for every user.

Create a dynamic questioning system that asks questions only when relevant.

Potential topics:
- Recent falls, slips or near-falls
- Pain and stiffness
- Dizziness or lightheadedness
- Fatigue
- Sleep quantity and quality
- Recent illness
- Medication changes
- Hydration and food intake
- Physical therapy or exercise
- Walking aids
- Mobility confidence
- Fear of falling
- Footwear or environment changes
- Mood, loneliness and emotional well-being
- Changes noticed by the user or caregiver

Research adaptive questionnaires, validated patient-reported outcome measures, active learning, information gain, and methods to minimize question burden.

The system should combine direct responses with existing sensor evidence while making it clear that a person's silence does not imply absence of symptoms.

Distinguish:
- Routine conversational questions
- Clinically useful follow-up questions
- Urgent safety-screening questions

Evaluate which questions should be asked immediately, after a session, during a daily check-in, or only when the user chooses.

---

# 7. CREATE THE VSPIMU PERSONAL COMPANION

This is a major component, not a decorative chatbot.

Design an elderly-friendly conversational AI companion capable of natural, multilingual communication.

Its goals:
- Build familiarity through consistent, respectful conversations
- Remember user-approved preferences and relevant context
- Explain complicated health measurements simply
- Encourage appropriate daily movement and independence
- Offer nonjudgmental support
- Discuss ordinary topics, not just medical measurements
- Conduct gentle daily check-ins
- Identify when reported symptoms should be addressed
- Connect conversation history to longitudinal mobility observations
- Help the user prepare for clinical appointments
- Explain doctor-recommended exercises or routines without replacing the clinician
- Summarize meaningful changes for approved caregivers

Research:
- Voice-first interaction
- Text and voice interfaces
- Hindi, Gujarati and English
- Speech-to-text and text-to-speech
- Accessible fonts and large controls
- Slow/clear speech options
- Simple explanations and repetition
- Personalized reminders
- Optional caregiver interaction
- Consent-based memory
- Context-aware conversation
- Long-term preference tracking
- User control over sensitive information

The companion should feel approachable and consistent, but must identify itself as AI.

Do not design emotional manipulation, dependency, deceptive friendship, or strategies that make an older adult follow advice unquestioningly.

The desired outcome is **well-informed confidence and adherence to appropriate advice**, with continued user autonomy and clinician oversight.

Explore how a conversational companion can improve real-world usefulness without presenting itself as a human doctor.

---

# 8. FIND THE BEST FREE, OPEN-SOURCE CHATBOT ARCHITECTURE

I strongly prefer:
- Free software
- Open-source/open-weight options
- No mandatory per-request API charge
- No artificial commercial message quotas
- No forced paid subscription
- Offline or privacy-preserving operation where practical
- Integration into our MIT App Inventor/WebViewer Android application

Research all viable approaches:

1. Small language models running locally on Android
2. Quantized open-weight models
3. Local inference runtimes appropriate for Android
4. A companion service running on user-owned computing hardware
5. Self-hosted inference servers
6. Hybrid offline/online systems
7. Retrieval-augmented generation using validated knowledge
8. Rule-based safety logic combined with language-model conversation
9. Low-cost or free hosted options, with their real limits clearly disclosed

Compare practical choices based on:
- Model quality
- Memory footprint
- Android compatibility
- RAM and battery use
- Inference latency
- Multilingual ability
- Long-context handling
- Privacy
- Commercial-use/licence terms
- Operational cost
- Hosting complexity
- Maintenance burden
- Clinical safety considerations

A genuinely unlimited, permanently free hosted inference API may not exist. Do not invent one.

Explain whether **self-hosting or offline inference**, which avoids per-request commercial billing but remains limited by hardware and operating costs, is the most sustainable answer.

Recommend a primary architecture and a fallback.

---

# 9. RESEARCH FUTURE PHYSIOLOGICAL + MOBILITY FUSION

Our long-term objective is to understand how internal physiological changes and external mobility changes relate.

Future possible inputs:
- Heart rate
- Resting heart-rate trends
- HRV, if validly measured
- SpO₂, if validly measured
- Skin/body-temperature trends where appropriate
- Sleep-related measurements, if independently validated
- Other inexpensive, scientifically useful sensor signals

Explore future use cases:

**A. Personalized fall-related screening**
Combine validated physiological changes, mobility trends, symptoms, environmental context, and prior fall history to study whether meaningful risk-related warnings can be developed.

**B. Pain, stiffness and treatment monitoring**
Track whether mobility/function changes correlate with patient-reported pain, prescribed therapy, medication timing, or recovery progress.

**C. Recovery versus sedentary behavior**
Investigate whether contextual movement and future physiological measurements can distinguish rest, low activity, restlessness and possible discomfort.

**D. Longitudinal functional decline**
Detect persistent changes relative to personal baseline that might warrant further assessment.

**E. Rehabilitation and medication response**
Create clear timelines of symptoms, functional outcomes, treatment events and measurement changes.

**F. Personalized independence support**
Help users maintain safe mobility, confidence, routine, and access to care.

Explicitly evaluate the limitations of each scenario. For example, resting-heart-rate and HRV changes cannot independently diagnose dehydration or infection; shank and pocket IMUs cannot directly establish physical foot drop in millimetres; and sleep metrics cannot prove that arthritis caused awakening.

Produce a phased roadmap showing which capabilities are possible now, which require future sensors, and which require clinical validation.

---

# 10. DESIGN PROACTIVE ASSISTANCE AND SAFETY

Research safe approaches for:

- Personalized mobility trend notifications
- Meaningful deterioration flags
- Symptom-dependent escalation
- Caregiver summaries with explicit consent
- Medication and activity logging
- Rehabilitation tracking
- Fall and near-fall journaling
- Missed-session follow-up
- Encouraging appropriate physical activity
- Support for people living alone
- Recognizing when advice must defer to a qualified clinician
- Emergency symptom screening and local emergency-service guidance

Design safety rules for concerning symptoms such as chest pain, acute neurological deficits, fainting, severe breathing difficulty, or serious falls.

The companion must not provide unsupported diagnoses, independently change medications, or instruct users to disregard medical professionals.

No automatic emergency contact, caregiver alert, or external data-sharing action without appropriate consent and a verified, reliable implementation.

---

# 11. BUILD LONGITUDINAL PERSONAL INTELLIGENCE

I don't want isolated 123-second reports.

Design a system that develops a progressively better understanding of each individual across days, weeks, and months.

Research:
- Individual baseline formation
- Normal day-to-day variability
- Session comparability and protocol consistency
- Longitudinal change detection
- Recovery and deterioration trends
- Changes in walking confidence
- Symptom-to-mobility correlations
- Effects of illness, exercise and therapy
- Changes in daily functional capacity
- Personalized targets and feedback
- Calibration drift and sensor-placement changes
- Seasonal or contextual effects
- Missing-data handling and irregular session schedules

The system should progressively build a useful, consent-based longitudinal profile without overfitting to noisy data.

Develop methods for determining whether an apparent change is real, reproducible, and clinically relevant.

Consider personal-baseline uncertainty, minimum detectable change, and longitudinal measurement reliability.

---

# 12. RESEARCH THE SCIENTIFIC VALIDATION FRAMEWORK

Accuracy is a primary goal.

We already have experience with Vicon/force-plate ground truth and comparisons of TCN, AFO, wavelet and hybrid gait-event detectors.

Develop an end-to-end validation plan covering:

- IC/FC event timing errors
- Sensitivity, precision, recall and F1
- Event matching criteria and matching tolerance
- Cadence and temporal metric errors
- MAE, RMSE and bias
- Bland–Altman agreement analysis where appropriate
- Test–retest reliability
- Sensitivity to device placement
- Sensor synchronization uncertainty
- BLE packet losses
- Phone sampling irregularity
- Different walking speeds
- Different populations and walking aids
- Stationary and transition segments
- Generalization to elderly and pathological gait
- Calibration and quality-control failures
- External validation
- Clinical interpretation reproducibility

Require independent validation data before claiming new clinical accuracy.

Separate:
- Engineering unit-test success
- Algorithm performance on synthetic data
- Retrospective benchmark performance
- Real-world hardware validation
- Clinical validity
- Clinical utility

Do not present one category as proof of another.

Find relevant open datasets, literature, reproducible algorithms and open-source reference implementations. Provide source URLs, publication dates, population details and study limitations.

---

# 13. IMPROVE THE REPORT EXPERIENCE RADICALLY

Design a report architecture containing:

**Executive mobility summary:** understandable overview, meaningful observations and any important limitations.

**Personalized change analysis:** how the user differs from their established baseline.

**Gait and mobility evidence:** detailed measured metrics, quality gates and visualizations.

**Functional implications:** evidence-supported explanations of what changes may mean for daily mobility.

**Contextual health insights:** appropriately cautious connections to reported symptoms, recent routines and future physiological inputs.

**Questions requiring follow-up:** dynamically generated, prioritized questions.

**Suggested next steps:** safe, proportionate guidance for self-monitoring, repeat measurement, rehabilitation discussion or clinical review.

**Clinical review section:** findings that merit professional assessment, with traceable evidence.

**Longitudinal trends:** changes over time and response to interventions.

**Clinician appendix:** units, algorithms, versions, calibration, sensor quality, uncertainty and supporting evidence.

**Companion explanation:** conversational presentation of the most useful findings, with opportunities for clarification.

Investigate how to minimize alert fatigue, avoid unnecessary anxiety, maintain clinical interpretability, and increase patient understanding.

Add other report sections if evidence suggests they will materially improve usefulness.

---

# 14. INVESTIGATE ADDITIONAL CREATIVE FEATURES

Go beyond my examples.

Independently research unconventional but scientifically credible ideas that could make VSPIMU substantially better.

Potential directions include:
- Active uncertainty reduction through targeted questions
- Personalized mobility digital phenotypes
- Mobility reserve and resilience measures
- Recovery trajectory estimation
- Medication/symptom/activity event timelines
- More useful personalized rehabilitation feedback
- Early identification of changes worth discussing with a doctor
- Repeat-assessment recommendations based on uncertainty
- Detection of poor sensor attachment versus genuine movement changes
- Comparisons of same-leg and opposite-leg phone placements
- Combining standardized tests with everyday contextual reports
- Accessible clinician handoff summaries
- Research-grade data provenance and audit trails
- Privacy-preserving personalization
- Companion-generated appointment preparation
- Caregiver summaries that preserve user autonomy
- Personalized quality-of-life and functional-goal tracking

For each proposal, determine whether it genuinely adds new information or merely repackages existing measurements.

Actively identify more original opportunities that I have not mentioned.

---

# 15. IMPLEMENTATION CONSTRAINTS

The system must remain realistic for our hardware and software.

Current requirements:
- Android application built with MIT App Inventor
- Minimal native App Inventor blocks
- As much functionality as possible in HTML/JavaScript/WebViewer
- Existing ESP32 BLE protocol preserved unless a change is truly justified
- Existing firmware and gait engine preserved as a baseline
- No reintroduction of Inertia-1
- Robust offline behavior for the existing assessment
- Computationally efficient processing
- Bounded memory and data storage
- Transparent handling of missing or interrupted sensor streams
- Exportable research data
- Straightforward installation and testing

Explore whether advanced features require native Android extensions, WebAssembly, WebGPU alternatives, Kotlin services, local databases, or other technologies. Distinguish features compatible with the current stack from those that would require a separate future implementation.

Do not silently assume an App Inventor WebViewer has unrestricted Android sensor, file-system, background-service, or local-model capabilities.

Preserve original files and create a separate working branch or package. Do not push to GitHub or overwrite the stable project until I explicitly authorize deployment.

---

# 16. PRIVACY, ETHICS, SAFETY AND REGULATORY RESEARCH

This system may eventually handle highly sensitive information about older adults.

Research:
- Explicit informed consent
- Data minimization
- Encryption and secure storage
- Access controls
- User-controlled deletion and export
- Caregiver access permissions
- On-device versus cloud processing
- Audit trails for generated medical interpretations
- Clinical AI safety evaluation
- Relevant Indian and international privacy requirements
- Potential medical-device regulatory classification
- Bias across age, sex, health conditions and mobility aids
- Risks of incorrect reassurance and false alarms
- Emergency escalation reliability
- Ethical long-term conversational companionship

Design a safe boundary between wellness assistance, clinical decision support, and regulated medical diagnosis.

---

# 17. HOW YOU MUST CONDUCT THE WORK

Follow a rigorous process:

**Phase A — Audit**

Inspect the complete VSPIMU codebase, current reports, model pipeline, sample formats, BLE transport, phone-sensor interfaces, tests and limitations.

**Phase B — Research**

Study the relevant peer-reviewed literature, open-source systems, public datasets, clinical guidelines, mobile AI runtimes and competing products.

**Phase C — Opportunity discovery**

Identify the largest gaps in the current system and the strongest opportunities for genuine improvement.

**Phase D — Scientific feasibility**

Classify every promising feature as:
- Implementable and supportable with current sensors
- Implementable but exploratory/unvalidated
- Requires additional measurements
- Requires clinical validation
- Unsupported or scientifically unjustified

**Phase E — Architecture**

Design an integrated system for sensing, signal processing, data-quality control, clinical inference, contextual questioning, personal memory, conversational interaction, reporting and safety escalation.

**Phase F — Prioritization**

Rank features by:
- Expected user benefit
- Clinical relevance
- Strength of evidence
- Expected accuracy
- Feasibility
- Cost
- Computational requirements
- Ease of integration
- Safety
- Validation effort

**Phase G — Prototype strategy**

Develop a detailed upgrade path from the current V6.1.3 prototype to the next report-intelligence prototype.

Identify exactly which algorithms, modules, UI components and report sections should change.

**Phase H — Testing and validation**

Specify unit tests, integration tests, realistic synthetic tests, hardware acceptance tests, reference-data benchmarks, failure handling and clinical validation requirements.

Use available tools to carry out useful research and code-level checks. Never claim physical-device tests or clinical validation were performed if they were not.

---

# 18. DELIVERABLES

Produce the following:

1. **Complete VSPIMU project audit** — what exists, what works, what is unverified, and what should change.

2. **Scientific feature catalog** — every promising metric, its source data, method, interpretation, validation status and limitations.

3. **Next-generation report specification** — a detailed structure with example findings, meaningful insights, visualizations and evidence grading.

4. **Inference and clinical-safety framework** — how the system reasons about changes without inventing diagnoses.

5. **Personal companion design** — personality, conversation flows, symptom follow-ups, accessibility, memory and consent.

6. **Open-source chatbot feasibility study** — concrete current options, architecture, costs, Android constraints, licences and an evidence-based recommendation.

7. **Multisensor fusion roadmap** — precise distinction between current capabilities and future wearable hardware.

8. **Validation research plan** — reference datasets, Vicon/force-plate testing, performance metrics, reproducibility and clinical evaluation.

9. **Technical system architecture** — modules, interfaces, data flow, storage, algorithms, computational resources and integration boundaries.

10. **Prioritized development roadmap** — immediate prototype, intermediate version, advanced research version, and longer-term clinical validation.

11. **Creative innovation proposals** — useful new features beyond the ideas I supplied.

12. **Concrete implementation plan** — exact files, components, functions, data schemas and tests needed to upgrade VSPIMU without breaking the current app.

13. **Illustrative report and companion interaction** — demonstrate how a realistic elderly user's valid sensor findings and self-reported information would be communicated. Label all example measurements as simulated.

14. **Research references and evidence ledger** — citations, URLs, study details, evidence strengths, limitations, and unresolved scientific questions.

Deliver an integrated system design rather than disconnected recommendations.

---

# 19. QUALITY STANDARD

I do not want a superficial response that merely says what might be possible.

Challenge my assumptions.

Reject ideas that cannot be supported scientifically.

Look for better alternatives than the methods I suggested.

Find creative opportunities that could materially improve understanding of the user's health and mobility.

Consider practical limitations, edge cases and real-world elderly-user behavior.

When a feature is not possible today, investigate precisely what measurements, algorithms or validation would make it possible.

When multiple approaches exist, compare them and make a clear recommendation.

Prioritize actual benefit to older adults, scientific credibility, explainability, accessibility and integration feasibility.

**Avoid a report that sounds medically intelligent but is scientifically unreliable.**

The objective is to create a system that is genuinely useful, transparent, clinically reviewable, technically achievable, and capable of improving over time.

---

# 20. STARTING INSTRUCTION

**Begin with the full research, feasibility study, architecture and prioritized design before making major implementation changes.**

Do not spend the entire effort producing generic background research.

By the end, provide a decisive recommendation for:

- The best VSPIMU report we can build with our existing sensors TODAY
- The strongest defensible clinical and functional insights available from those sensors
- The most practical personal companion architecture
- How the report engine and companion should interact
- Which additional measurements would create the most valuable future capabilities
- Exactly what to implement first, second and third

Do not wait for me to approve routine research decisions. Make reasonable engineering decisions independently, but preserve stable project files and do not deploy or publish unvalidated changes.

**The ultimate ambition: VSPIMU should evolve from a gait-measurement application into an intelligent, evidence-based, longitudinal mobility and health companion that helps older adults understand meaningful changes, maintain independence, and seek appropriate care when needed.**

Use the full depth of your available research, reasoning and technical capabilities to determine how to make that vision real.
