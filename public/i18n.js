/* i18n.js — UI strings in English and Hindi. Hazard labels come from standards.json (label_en / label_hi).
   Exposes window.RastaI18n = { t, lang, setLang, apply, onChange }. Static markup uses data-i18n="key"
   (text), data-i18n-attr="placeholder:key;title:key2" for attributes. */
(function () {
  const STRINGS = {
    en: {
      'tab.map': 'Map', 'tab.walk': 'Walk', 'tab.route': 'Route',
      'hz.submit': 'Open {auth} portal', 'hz.submit.any': 'File on Delhi PGMS', 'hz.copied.next': 'Complaint draft for {auth} copied. Paste it into the portal that just opened.',
      'seg.pins': 'Numbered pins on the map show roughly where each hazard was photographed.',
      'tip.osm': 'from OSM tags', 'tip.clear': 'no hazards recorded',
      'intro.skip': 'Skip intro', 'intro.tagline': 'Walk a street. The city gets mapped.', 'intro.sub': 'A crowdsourced footpath accessibility map',
      'seg.source.open': 'Graded from openly licensed photos on {site} taken at this spot. Walk it to add a current reading.',
      'seg.source.osm': 'Graded from <a href="{url}" target="_blank" rel="noopener">OpenStreetMap tags</a>, not yet photographed. Walk it to confirm what is on the ground.',
      'seg.verify': 'Verify this stretch with photos', 'seg.also': 'Also mapped here', 'seg.also.osm': 'OpenStreetMap tags', 'seg.also.walked': 'walked {date}', 'seg.also.away': '{m} m away',
      'seg.walk.set': 'Points set from this stretch. Add photos to verify it.',
      'ledger.segments': 'footpaths walked', 'ledger.hazards': 'hazards found', 'ledger.km': 'km covered', 'ledger.cost': 'to fix everything',
      'ledger.mock': 'Mock vision — add ANTHROPIC_API_KEY to .env', 'ledger.budget': "Today's analysis budget is used up",
      'lens.label': 'View the map as', 'lens.score': 'Score', 'lens.walk': 'Walking', 'lens.wheelchair': 'Wheelchair', 'lens.senior': 'Senior',
      'lens.note.score': 'Coloured by accessibility score. Average across the city is <b>{avg}</b>.',
      'lens.note.wheelchair': '<b>{ok} of {n}</b> walked footpaths can be used in a wheelchair.',
      'lens.note.senior': '<b>{ok} of {n}</b> walked footpaths are safe for an 80-year-old.',
      'lens.note.walk': '<b>{ok} of {n}</b> footpaths are passable on foot without a detour.',
      'legend.high': 'above 70', 'legend.mid': '40 to 70', 'legend.low': 'under 40',
      'map.locate': 'Centre on my location', 'map.fit': 'Fit all footpaths in view', 'map.skip': 'Skip to panel', 'map.aria': 'Footpath map',
      'empty.title': 'Tap a footpath.',
      'empty.body': 'Every coloured line is a stretch someone walked and photographed. Tap one to see what they found, who can pass it, and what it would cost to fix.',
      'empty.hint': 'Green passes. Amber slows people down. Red blocks a wheelchair or trips a senior.',
      'empty.none.title': 'Nothing mapped yet.', 'empty.none.body': 'Walk a footpath with the camera and it will appear here in colour.',
      'seg.loading': 'Loading…', 'seg.failed': "Couldn't load this footpath.", 'seg.close': 'Close', 'seg.report': 'Path report',
      'seg.meta': '{m} m · {hazards} · {photos}{width}', 'seg.hazard.one': '1 hazard', 'seg.hazard.many': '{n} hazards', 'seg.photo.one': '1 photo', 'seg.photo.many': '{n} photos', 'seg.width': ' · {w} m clear',
      'seg.nophotos': 'No photos on file for this stretch. Walk it again with the camera to add them.',
      'seg.nophotos.osm': 'No photos yet. This grade comes from map tags alone.', 'seg.fromtags': 'from map tags', 'seg.photo.none': 'no photos',
      'seg.walk': 'Walk this stretch with photos', 'ledger.opendata': 'from open data', 'map.import': 'Add OpenStreetMap data for this area', 'legend.thin': 'thin: from OpenStreetMap tags',
      'seg.nohazards': 'No hazards recorded. This is what a footpath should look like.',
      'seg.photo.alt': 'Footpath photo', 'seg.photo.missing': 'Photo missing from disk', 'seg.photo.failed': 'Analysis failed for this photo', 'seg.photo.mock': 'mock analysis',
      'hz.copy': 'Copy complaint draft', 'hz.enforce': 'enforce', 'hz.copied': 'Complaint draft for {auth} copied', 'hz.clipboard': 'Clipboard blocked by the browser', 'hz.authority': 'the authority',
      'cost.total': 'To fix this stretch', 'cost.none': 'No repair cost — enforcement only', 'cost.none.short': 'No repair cost',
      'persona.walk': 'Walking', 'persona.wheelchair': 'Wheelchair', 'persona.senior': 'Senior', 'verdict.pass': 'passes', 'verdict.fail': 'blocked',
      'c.step1': 'Mark the stretch you walked', 'c.hint0': 'Tap the map where you started, then where you stopped.', 'c.hint1': 'Now tap where you stopped.', 'c.hint2': 'Drag the markers to adjust.',
      'c.start': 'start', 'c.end': 'end', 'c.len': '<b>{m} m</b> stretch', 'c.clear': 'Clear', 'c.gps.one': 'Place start from photo GPS', 'c.gps.many': 'Place from photo GPS ({n} photos)', 'c.gps.title': 'Use the location stored in the first and last photo',
      'c.gps.placed': 'Placed from {n} geotagged photos. Drag the markers if the GPS was off.', 'c.gps.start': 'Start placed from the photo. Tap the map where you stopped.',
      'c.step2': 'Name it the way a local would', 'c.name.ph': 'Metro Gate 3 to the bus stop',
      'c.step3': 'Add the photos', 'c.step3.body': 'Every 20 to 30 metres, pointing along the footpath. Phone photos are resized on your device before upload.',
      'c.drop': 'Take or choose photos', 'c.drop.small': 'up to 12 · JPG, PNG, HEIC converts on iPhone', 'c.remove': 'Remove photo', 'c.room': 'Only {n} more photo(s) fit (12 max)',
      'c.analyse': 'Analyse footpath', 'c.count.one': '1 photo', 'c.count.many': '{n} photos',
      'c.note.analysing': 'Analysing in parallel…', 'c.note.both': 'Mark two points and add at least one photo.', 'c.note.points': 'Mark where the stretch starts and ends.', 'c.note.photos': 'Add at least one photo.',
      'c.note.ready': 'One model call per photo, all at once. Cached photos come back instantly.',
      'c.unnamed': 'Unnamed footpath', 'c.hazards': 'hazards', 'c.dial.cap': 'out of 100', 'c.dial.analysing': 'analysing',
      'c.failed.photo': "Couldn't analyse: {err}", 'c.mock': 'mock — no API key', 'c.cached': 'cached',
      'c.budget': "Today's analysis budget is used up. Photos were saved without hazards — try again tomorrow.",
      'c.added': 'Added "{name}" to the map', 'c.failed': 'Analysis failed: {err}', 'c.failed.note': 'Analysis failed: {err}. Nothing was saved — try again.', 'c.noresult': 'No result came back',
      'c.view': 'See it on the map', 'c.another': 'Walk another',
      'c.queued': 'You are offline. This walk is saved on your phone and will upload when you are back online.',
      'c.queue.badge.one': '1 walk waiting to upload', 'c.queue.badge.many': '{n} walks waiting to upload', 'c.queue.sync': 'Upload now',
      'c.replayed': 'Uploaded a walk saved offline: "{name}"', 'c.replay.failed': 'A saved walk could not be uploaded: {err}',
      'sr.score': 'Accessibility score {score} out of 100. {hazards} hazards found.',
      'r.step1': 'Where from, where to', 'r.hint0': 'Tap the map for A, then B.', 'r.hint1': 'Now tap the destination.', 'r.hint2': 'Drag the markers to adjust.',
      'r.from': 'from', 'r.to': 'to', 'r.demo': 'Use demo pair', 'r.clear': 'Clear', 'r.step2': 'Who is walking', 'r.persona.aria': 'Persona',
      'r.compare': 'Compare routes', 'r.note.pick': 'Pick two points first.', 'r.note.apart': '{km} km apart as the crow flies', 'r.note.asking': 'Asking the routing server…',
      'r.note.done': '{n} route(s) compared for {persona}.', 'r.persona.walk': 'a walking person', 'r.persona.wheelchair': 'a wheelchair user', 'r.persona.senior': 'a senior',
      'r.failed': 'Routing failed: {err}', 'r.only': 'Only route found', 'r.rec': 'Recommended', 'r.n': 'Route {n}', 'r.best': 'best with data',
      'r.meta': '{km} km · {min} min · {cov}% of the way has been walked', 'r.nodata': 'no<br>data',
      'r.worst': 'Worst on the way: <b>{label}</b> ({sev}/5) on {seg}', 'r.clean': 'No hazards recorded on the covered stretches', 'r.toolittle': 'Too little of this route has been walked to score it',
      'r.blocked': 'Blocked for {persona}: {seg}', 'r.more': ' and {n} more',
      'r.search': 'Search', 'r.search.ph': 'Search a place, or tap the map', 'r.searching': 'Searching…', 'r.noresults': 'No place found for "{q}". Try a landmark, metro station or road name, or tap the map.',
      'r.geo.failed': 'Place search failed: {err}', 'r.swap': 'Swap A and B', 'r.setA': 'B is set. Now search or tap where you start (A).',
      'r.min': '{n} min', 'r.blocked.short': 'blocked', 'r.best.for': 'Best for {persona}', 'r.times.title': 'Time on foot · in a wheelchair · for a senior, with detours for hazards',
      'r.problems': '{n} problems on this route', 'r.problem': '1 problem on this route', 'r.noproblems': 'No recorded problems on the walked parts',
      'r.start': 'Start walking', 'r.stop': 'Stop', 'r.walk.progress': '<b>{done}</b> of {total} · about <b>{min} min</b> left at {persona} pace',
      'r.next': 'Next: {label} in {m} m', 'r.next.none': 'No more recorded problems ahead', 'r.near': 'Coming up: {label} ({sev}/5) on {seg}',
      'r.arrived': 'You have arrived. {n} recorded problem(s) passed on the way.', 'r.speed.walk': 'walking', 'r.speed.wheelchair': 'wheelchair', 'r.speed.senior': 'senior',
      'toast.stats': 'Stats unavailable: {err}', 'toast.segments': 'Could not load footpaths: {err}', 'toast.server': 'Server unreachable', 'toast.knowledge': 'Knowledge file failed to load — hazard labels will be raw ids',
      'toast.tiles': 'Map tiles are not loading. Check the connection; footpaths still work.',
      'toast.locate.start': 'Start set to your location. Tap where you stopped.', 'toast.locate.route': 'Starting from your location. Tap the destination.',
      'toast.demo.loaded': 'Demo loaded: {n} photo(s) ready', 'toast.demo.missing': 'Demo photo {f} missing', 'toast.demo.failed': 'Demo mode: {err}. Add public/demo/manifest.json',
      'toast.offline': 'You are offline. The map shows what was last loaded; new walks will be queued.', 'toast.online': 'Back online.',
      'lang.toggle': 'हिन्दी', 'lang.aria': 'Switch language to Hindi',
    },
    hi: {
      'tab.map': 'नक्शा', 'tab.walk': 'चलें', 'tab.route': 'रास्ता',
      'hz.submit': '{auth} पोर्टल खोलें', 'hz.submit.any': 'दिल्ली PGMS पर दर्ज करें', 'hz.copied.next': '{auth} के लिए शिकायत का मसौदा कॉपी हुआ। अभी खुले पोर्टल में चिपकाएँ।',
      'seg.pins': 'नक्शे पर नंबर वाले पिन बताते हैं कि हर खतरे की फोटो लगभग कहाँ ली गई।',
      'tip.osm': 'OSM टैग से', 'tip.clear': 'कोई खतरा दर्ज नहीं',
      'intro.skip': 'इंट्रो छोड़ें', 'intro.tagline': 'एक सड़क चलिए। शहर का नक्शा बनता है।', 'intro.sub': 'लोगों का बनाया फुटपाथ पहुँच नक्शा',
      'seg.source.open': '{site} पर मौजूद खुली लाइसेंस वाली, इसी जगह की फोटो से ग्रेड किया गया। ताज़ा रीडिंग जोड़ने के लिए इसे चलें।',
      'seg.source.osm': '<a href="{url}" target="_blank" rel="noopener">OpenStreetMap टैग</a> से ग्रेड किया गया, अभी फोटो नहीं। ज़मीन पर पुष्टि के लिए इसे चलें।',
      'seg.verify': 'फोटो से इस हिस्से की पुष्टि करें', 'seg.also': 'यहाँ और रीडिंग', 'seg.also.osm': 'OpenStreetMap टैग', 'seg.also.walked': '{date} को चला', 'seg.also.away': '{m} मी दूर',
      'seg.walk.set': 'इस हिस्से से बिंदु सेट हुए। पुष्टि के लिए फोटो जोड़ें।',
      'ledger.segments': 'फुटपाथ चले', 'ledger.hazards': 'खतरे मिले', 'ledger.km': 'किमी कवर', 'ledger.cost': 'सब ठीक करने का खर्च',
      'ledger.mock': 'नकली विश्लेषण — .env में ANTHROPIC_API_KEY जोड़ें', 'ledger.budget': 'आज का विश्लेषण बजट खत्म हो गया',
      'lens.label': 'नक्शा देखें', 'lens.score': 'स्कोर', 'lens.walk': 'पैदल', 'lens.wheelchair': 'व्हीलचेयर', 'lens.senior': 'वरिष्ठ',
      'lens.note.score': 'पहुँच स्कोर के रंग में। शहर का औसत <b>{avg}</b> है।',
      'lens.note.wheelchair': '<b>{n} में से {ok}</b> फुटपाथ व्हीलचेयर से चलने योग्य हैं।',
      'lens.note.senior': '<b>{n} में से {ok}</b> फुटपाथ 80 साल के व्यक्ति के लिए सुरक्षित हैं।',
      'lens.note.walk': '<b>{n} में से {ok}</b> फुटपाथ बिना चक्कर लगाए पैदल पार हो सकते हैं।',
      'legend.high': '70 से ऊपर', 'legend.mid': '40 से 70', 'legend.low': '40 से कम',
      'map.locate': 'मेरी जगह पर केंद्रित करें', 'map.fit': 'सभी फुटपाथ दिखाएँ', 'map.skip': 'पैनल पर जाएँ', 'map.aria': 'फुटपाथ का नक्शा',
      'empty.title': 'किसी फुटपाथ पर टैप करें।',
      'empty.body': 'हर रंगीन रेखा एक ऐसा हिस्सा है जिस पर कोई चला और तस्वीरें लीं। टैप करके देखें कि क्या मिला, कौन पार कर सकता है, और ठीक करने में कितना खर्च होगा।',
      'empty.hint': 'हरा ठीक है। पीला धीमा करता है। लाल व्हीलचेयर को रोकता है या बुज़ुर्ग को गिरा सकता है।',
      'empty.none.title': 'अभी कुछ मैप नहीं हुआ।', 'empty.none.body': 'कैमरे के साथ किसी फुटपाथ पर चलें और वह यहाँ रंग में दिखेगा।',
      'seg.loading': 'लोड हो रहा है…', 'seg.failed': 'यह फुटपाथ लोड नहीं हो सका।', 'seg.close': 'बंद करें', 'seg.report': 'पथ रिपोर्ट',
      'seg.meta': '{m} मी · {hazards} · {photos}{width}', 'seg.hazard.one': '1 खतरा', 'seg.hazard.many': '{n} खतरे', 'seg.photo.one': '1 फ़ोटो', 'seg.photo.many': '{n} फ़ोटो', 'seg.width': ' · {w} मी खाली चौड़ाई',
      'seg.nophotos': 'इस हिस्से की कोई तस्वीर नहीं है। कैमरे के साथ दोबारा चलकर जोड़ें।',
      'seg.nophotos.osm': 'अभी कोई तस्वीर नहीं। यह ग्रेड केवल नक्शे के टैग से है।', 'seg.fromtags': 'नक्शे के टैग से', 'seg.photo.none': 'कोई फ़ोटो नहीं',
      'seg.walk': 'इस हिस्से पर तस्वीरों के साथ चलें', 'ledger.opendata': 'खुले डेटा से', 'map.import': 'इस क्षेत्र का OpenStreetMap डेटा जोड़ें', 'legend.thin': 'पतली रेखा: OpenStreetMap टैग से',
      'seg.nohazards': 'कोई खतरा दर्ज नहीं। फुटपाथ ऐसा ही होना चाहिए।',
      'seg.photo.alt': 'फुटपाथ की तस्वीर', 'seg.photo.missing': 'तस्वीर डिस्क पर नहीं मिली', 'seg.photo.failed': 'इस तस्वीर का विश्लेषण विफल', 'seg.photo.mock': 'नकली विश्लेषण',
      'hz.copy': 'शिकायत का मसौदा कॉपी करें', 'hz.enforce': 'प्रवर्तन', 'hz.copied': '{auth} के लिए शिकायत का मसौदा कॉपी हुआ', 'hz.clipboard': 'ब्राउज़र ने क्लिपबोर्ड रोक दिया', 'hz.authority': 'प्राधिकरण',
      'cost.total': 'इस हिस्से को ठीक करने का खर्च', 'cost.none': 'मरम्मत खर्च नहीं — केवल प्रवर्तन', 'cost.none.short': 'मरम्मत खर्च नहीं',
      'persona.walk': 'पैदल', 'persona.wheelchair': 'व्हीलचेयर', 'persona.senior': 'वरिष्ठ', 'verdict.pass': 'पार हो सकता', 'verdict.fail': 'रुका हुआ',
      'c.step1': 'जिस हिस्से पर चले उसे चिह्नित करें', 'c.hint0': 'नक्शे पर वहाँ टैप करें जहाँ से शुरू किया, फिर जहाँ रुके।', 'c.hint1': 'अब वहाँ टैप करें जहाँ रुके।', 'c.hint2': 'सही करने के लिए मार्कर खींचें।',
      'c.start': 'शुरू', 'c.end': 'अंत', 'c.len': '<b>{m} मी</b> का हिस्सा', 'c.clear': 'साफ़ करें', 'c.gps.one': 'फ़ोटो GPS से शुरू रखें', 'c.gps.many': 'फ़ोटो GPS से रखें ({n} फ़ोटो)', 'c.gps.title': 'पहली और आखिरी फ़ोटो में दर्ज जगह का उपयोग करें',
      'c.gps.placed': '{n} जियोटैग फ़ोटो से रखा गया। GPS गलत हो तो मार्कर खींचें।', 'c.gps.start': 'फ़ोटो से शुरू रखा गया। जहाँ रुके वहाँ टैप करें।',
      'c.step2': 'ऐसा नाम दें जैसा स्थानीय लोग देते हैं', 'c.name.ph': 'मेट्रो गेट 3 से बस स्टॉप तक',
      'c.step3': 'तस्वीरें जोड़ें', 'c.step3.body': 'हर 20 से 30 मीटर पर, फुटपाथ की दिशा में। फ़ोन की तस्वीरें अपलोड से पहले आपके डिवाइस पर छोटी की जाती हैं।',
      'c.drop': 'तस्वीर लें या चुनें', 'c.drop.small': 'अधिकतम 12 · JPG, PNG, iPhone पर HEIC बदल जाता है', 'c.remove': 'तस्वीर हटाएँ', 'c.room': 'केवल {n} और तस्वीर(ें) जोड़ सकते हैं (अधिकतम 12)',
      'c.analyse': 'फुटपाथ का विश्लेषण करें', 'c.count.one': '1 फ़ोटो', 'c.count.many': '{n} फ़ोटो',
      'c.note.analysing': 'एक साथ विश्लेषण हो रहा है…', 'c.note.both': 'दो बिंदु चिह्नित करें और कम से कम एक फ़ोटो जोड़ें।', 'c.note.points': 'हिस्से का शुरू और अंत चिह्नित करें।', 'c.note.photos': 'कम से कम एक फ़ोटो जोड़ें।',
      'c.note.ready': 'हर फ़ोटो के लिए एक मॉडल कॉल, सब एक साथ। पहले देखी फ़ोटो तुरंत लौटती हैं।',
      'c.unnamed': 'बिना नाम का फुटपाथ', 'c.hazards': 'खतरे', 'c.dial.cap': '100 में से', 'c.dial.analysing': 'विश्लेषण जारी',
      'c.failed.photo': 'विश्लेषण नहीं हो सका: {err}', 'c.mock': 'नकली — API कुंजी नहीं', 'c.cached': 'पहले से',
      'c.budget': 'आज का विश्लेषण बजट खत्म हो गया। तस्वीरें बिना खतरों के सहेजी गईं — कल फिर कोशिश करें।',
      'c.added': '"{name}" नक्शे में जोड़ा गया', 'c.failed': 'विश्लेषण विफल: {err}', 'c.failed.note': 'विश्लेषण विफल: {err}। कुछ सहेजा नहीं गया — फिर कोशिश करें।', 'c.noresult': 'कोई परिणाम नहीं आया',
      'c.view': 'नक्शे पर देखें', 'c.another': 'और एक चलें',
      'c.queued': 'आप ऑफ़लाइन हैं। यह वॉक आपके फ़ोन में सहेज ली गई है और ऑनलाइन होते ही अपलोड हो जाएगी।',
      'c.queue.badge.one': '1 वॉक अपलोड की प्रतीक्षा में', 'c.queue.badge.many': '{n} वॉक अपलोड की प्रतीक्षा में', 'c.queue.sync': 'अभी अपलोड करें',
      'c.replayed': 'ऑफ़लाइन सहेजी वॉक अपलोड हुई: "{name}"', 'c.replay.failed': 'एक सहेजी वॉक अपलोड नहीं हो सकी: {err}',
      'sr.score': 'पहुँच स्कोर 100 में से {score}। {hazards} खतरे मिले।',
      'r.step1': 'कहाँ से, कहाँ तक', 'r.hint0': 'नक्शे पर A, फिर B टैप करें।', 'r.hint1': 'अब गंतव्य टैप करें।', 'r.hint2': 'सही करने के लिए मार्कर खींचें।',
      'r.from': 'से', 'r.to': 'तक', 'r.demo': 'डेमो जोड़ी', 'r.clear': 'साफ़ करें', 'r.step2': 'कौन चल रहा है', 'r.persona.aria': 'व्यक्ति',
      'r.compare': 'रास्तों की तुलना करें', 'r.note.pick': 'पहले दो बिंदु चुनें।', 'r.note.apart': 'सीधी दूरी {km} किमी', 'r.note.asking': 'रूटिंग सर्वर से पूछ रहे हैं…',
      'r.note.done': '{persona} के लिए {n} रास्तों की तुलना हुई।', 'r.persona.walk': 'पैदल चलने वाले', 'r.persona.wheelchair': 'व्हीलचेयर उपयोगकर्ता', 'r.persona.senior': 'वरिष्ठ नागरिक',
      'r.failed': 'रूटिंग विफल: {err}', 'r.only': 'केवल एक रास्ता मिला', 'r.rec': 'अनुशंसित', 'r.n': 'रास्ता {n}', 'r.best': 'डेटा के साथ सबसे अच्छा',
      'r.meta': '{km} किमी · {min} मिनट · रास्ते का {cov}% चला गया है', 'r.nodata': 'डेटा<br>नहीं',
      'r.worst': 'रास्ते में सबसे बुरा: <b>{label}</b> ({sev}/5), {seg} पर', 'r.clean': 'कवर किए हिस्सों में कोई खतरा दर्ज नहीं', 'r.toolittle': 'इस रास्ते का बहुत कम हिस्सा चला गया है, स्कोर नहीं दिया जा सकता',
      'r.blocked': '{persona} के लिए रुका हुआ: {seg}', 'r.more': ' और {n} अन्य',
      'r.search': 'खोजें', 'r.search.ph': 'जगह खोजें, या नक्शे पर टैप करें', 'r.searching': 'खोज रहे हैं…', 'r.noresults': '"{q}" के लिए कोई जगह नहीं मिली। कोई लैंडमार्क, मेट्रो स्टेशन या सड़क का नाम लिखें, या नक्शे पर टैप करें।',
      'r.geo.failed': 'जगह की खोज विफल: {err}', 'r.swap': 'A और B बदलें', 'r.setA': 'B तय है। अब जहाँ से शुरू करेंगे (A) वह खोजें या टैप करें।',
      'r.min': '{n} मिनट', 'r.blocked.short': 'रुका हुआ', 'r.best.for': '{persona} के लिए सबसे अच्छा', 'r.times.title': 'पैदल · व्हीलचेयर · वरिष्ठ के लिए समय, खतरों के चक्कर सहित',
      'r.problems': 'इस रास्ते पर {n} समस्याएँ', 'r.problem': 'इस रास्ते पर 1 समस्या', 'r.noproblems': 'चले गए हिस्सों में कोई दर्ज समस्या नहीं',
      'r.start': 'चलना शुरू करें', 'r.stop': 'रोकें', 'r.walk.progress': '{total} में से <b>{done}</b> · {persona} गति से लगभग <b>{min} मिनट</b> बाकी',
      'r.next': 'आगे: {m} मी पर {label}', 'r.next.none': 'आगे कोई दर्ज समस्या नहीं', 'r.near': 'सामने: {seg} पर {label} ({sev}/5)',
      'r.arrived': 'आप पहुँच गए। रास्ते में {n} दर्ज समस्या(एँ) मिलीं।', 'r.speed.walk': 'पैदल', 'r.speed.wheelchair': 'व्हीलचेयर', 'r.speed.senior': 'वरिष्ठ',
      'toast.stats': 'आँकड़े उपलब्ध नहीं: {err}', 'toast.segments': 'फुटपाथ लोड नहीं हो सके: {err}', 'toast.server': 'सर्वर से संपर्क नहीं', 'toast.knowledge': 'ज्ञान फ़ाइल लोड नहीं हुई — खतरों के नाम कच्चे आईडी दिखेंगे',
      'toast.tiles': 'नक्शे की टाइलें लोड नहीं हो रहीं। कनेक्शन जाँचें; फुटपाथ फिर भी काम करेंगे।',
      'toast.locate.start': 'शुरू आपकी जगह पर रखा गया। जहाँ रुके वहाँ टैप करें।', 'toast.locate.route': 'आपकी जगह से शुरू। गंतव्य टैप करें।',
      'toast.demo.loaded': 'डेमो लोड: {n} फ़ोटो तैयार', 'toast.demo.missing': 'डेमो फ़ोटो {f} नहीं मिली', 'toast.demo.failed': 'डेमो मोड: {err}। public/demo/manifest.json जोड़ें',
      'toast.offline': 'आप ऑफ़लाइन हैं। नक्शा आखिरी लोड दिखा रहा है; नई वॉक कतार में रहेंगी।', 'toast.online': 'फिर से ऑनलाइन।',
      'lang.toggle': 'English', 'lang.aria': 'भाषा अंग्रेज़ी में बदलें',
    },
  };

  const KEY = 'rasta.lang';
  let lang = (() => { try { const v = localStorage.getItem(KEY); if (v === 'hi' || v === 'en') return v; } catch { /* private mode */ } return /^hi\b/i.test(navigator.language || '') ? 'hi' : 'en'; })();
  const listeners = [];

  function t(key, vars) {
    let s = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
    if (vars) for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
    return s;
  }

  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.innerHTML = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      for (const pair of el.dataset.i18nAttr.split(';')) { const [attr, key] = pair.split(':').map((x) => x.trim()); if (attr && key) el.setAttribute(attr, t(key)); }
    });
    document.documentElement.lang = lang;
    document.documentElement.dataset.lang = lang;
  }

  function setLang(next) {
    if (next !== 'hi' && next !== 'en') return;
    lang = next;
    try { localStorage.setItem(KEY, lang); } catch { /* ignore */ }
    apply();
    listeners.forEach((fn) => fn(lang));
  }

  window.RastaI18n = { t, get lang() { return lang; }, setLang, apply, onChange: (fn) => listeners.push(fn), STRINGS };
})();
