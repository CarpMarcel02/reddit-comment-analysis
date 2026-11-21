# Context Proiect NLP2 — Detecția Propagandei pe Reddit (Pentru Gemini)

Copiază textul de mai jos și lipește-l în orice fereastră nouă de chat Gemini (ex. pe gemini.google.com sau alt LLM) ca să știe tot ce am lucrat până acum:

---

```markdown
Salut! Lucrez la proiectul meu de semestru pentru cursul de NLP2 (Master, Anul 2, Semestrul 1). Vreau să mă ajuți în continuare cu dezvoltarea, analiza datelor, modelele și redactarea lucrării. Iată contextul complet al proiectului, deciziile luate și unde am rămas:

### 1. Despre ce este proiectul
- **Obiectiv:** O lucrare de cercetare științifică în format ACL (6–8 pagini), care valorează 70% din nota finală.
- **Deadline apropiat:** 1 Decembrie (raport preliminar pe canalul de proiect cu distribuții de clase, primele ploturi, idei de arhitectură).
- **Tema:** Detecția tehnicilor de propagandă în comentariile de pe Reddit legate de războiul Rusia–Ucraina pe perioada 24 feb. 2021 – 24 feb. 2023 (1 an înainte și 1 an după invazia pe scară largă).
- **Date:** 8 subreddit-uri extrase din arhivele Pushshift (.zst JSONL streaming, ~5 GB total):
  - *Control / moderare strictă:* r/CredibleDefense, r/geopolitics
  - *Pro-Ucraina:* r/ukraine, r/UkrainianConflict
  - *Pro-Rusia / perspectivă rusă:* r/UkraineRussiaReport, r/AskARussian, r/russia
  - *Umor / sarcasm:* r/NonCredibleDefense
- **Filtrare:** Comentarii între 25–300 cuvinte (fără citate `>`), fără boți, fără șterse, doar limba engleză (max 20% caractere chirilice).

### 2. Schema de etichetare (4 clase):
1. Name Calling / Ad Hominem (insulte, dezumanizare: „orcs”, „vatniks”, „Putin's bots”, atac la persoană)
2. Appeal to Fear / Catastrophizing (induce panică: „WW3”, „vine războiul nuclear”, scenarii apocaliptice)
3. Whataboutism / Distraction („dar ce a făcut SUA în Irak?”, „toți mint”, schimbarea subiectului)
4. Neutral / Non-propaganda (analize, opinii raționale, știri, întrebări sincere, glume inofensive)
*Regulă:* Se alege tehnica dominantă. Majoritatea datelor reale sunt Neutral (~60-80%).

### 3. Arhitectură și Decizii Tehnice:
- **Aplicația locală (Archive Viewer):** Avem un server Python local (`app.py`) cu backend SQLite (în `cache/`) și interfață web dedicată pentru parcurs arhivele și etichetat.
- **Resurse de calcul:** Am acces la GPU-uri pe Google Cloud.
- **Strategia de modelare aleasă:** **Active Learning cu LoRA / QLoRA** pe un LLM open-source de ~7B/8B (ex: Llama-3.1-8B sau Qwen-2.5-7B). Nu folosim API-uri externe plătite.
  - Test Set curat (Gold Set fix): Cele 50 de comentarii Shared (pentru măsurat acuratețea reală și Cohen's Kappa).
  - Train Set iterativ: Învățare iterativă (Active Learning pe cazurile cele mai nesigure / uncertainty sampling).

### 4. Unde suntem acum (Status curent):
- Tooling-ul, indexarea celor 8 subreddit-uri și baza de date sunt 100% gata.
- Eșantionul final a fost generat pentru cei doi adnotatori (Marcel și Antonio): 20 Pilot, 50 Shared, 75 individuale de om (total 200 comentarii gold).
- **Pilotul (cele 20 de comentarii) tocmai a fost finalizat** cu succes (distribuție: ~61% Neutral, ~17% Name Calling, ~13% Whataboutism, ~9% Appeal to Fear).
- **Următorul pas:** Etichetarea independentă a celor 50 de comentarii Shared (pentru calculul acordului inter-adnotator Cohen's Kappa) și a comentariilor individuale.

Te rog să ții cont de acest context în toate răspunsurile și să mă ghidezi în pașii următori.
```
