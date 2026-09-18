/**
 * Clinical history ontology for the intake kiosk.
 *
 * The dialogue is a state machine over this graph, not a free-form chat. Every
 * question the patient can be asked is declared here, so the transcript is
 * reproducible, reviewable by a clinician, and incapable of inventing a question
 * nobody approved. The optional LLM layer (intake/llm.js) may only rephrase these
 * prompts into the patient's language or pick which declared branch to take next —
 * it can never introduce a new clinical question.
 *
 * Question shape
 *   id       stable key; answers are stored under this
 *   section  which part of the standard history this feeds
 *   type     single | multi | scale | duration | number | text
 *   prompt   { en, hi } — spoken aloud and shown on screen
 *   options  [{ value, label:{en,hi}, icon, flags:[] }]
 *   when     optional guard, evaluated against answers collected so far
 *
 * Provenance: the allopathic sections follow the standard history structure
 * (chief complaint, HPI via SOCRATES, past, drug/allergy, family, personal, ROS)
 * named in SIH26047. The AYUSH section follows Dashavidha Pariksha as taught in
 * Ayurvedic case-taking — the ten-fold examination the problem statement lists.
 */

const LANGUAGES = [
  { code: 'hi', label: 'हिन्दी', english: 'Hindi', speech: 'hi-IN' },
  { code: 'en', label: 'English', english: 'English', speech: 'en-IN' }
];

/**
 * Chief complaints are the entry point: a patient taps or says one, and it selects
 * the follow-up branch plus the NAMASTE concepts the coder will consider.
 *
 * `candidates` are namasteCode values from the official release (data/namaste_terminology.json).
 * They are candidates, not conclusions — the physician confirms the diagnosis, and
 * intake/coder.js only proposes codes with the evidence that supported them.
 */
const CHIEF_COMPLAINTS = [
  {
    id: 'chest_pain', icon: '🫀', branch: 'pain',
    label: { en: 'Chest pain', hi: 'छाती में दर्द' },
    candidates: ['AAB-84', 'AAB-111'],
    site: { en: 'chest', hi: 'छाती' }
  },
  {
    id: 'acidity', icon: '🔥', branch: 'digestive',
    label: { en: 'Acidity or burning in stomach', hi: 'पेट में जलन या खट्टी डकार' },
    candidates: ['EB-4', 'EB-4.1', 'EB-4.2'],
    site: { en: 'upper abdomen', hi: 'ऊपरी पेट' }
  },
  {
    id: 'fever', icon: '🌡️', branch: 'fever',
    label: { en: 'Fever', hi: 'बुखार' },
    candidates: ['EC-3', 'EC-3.2']
  },
  {
    id: 'cough_cold', icon: '🤧', branch: 'respiratory',
    label: { en: 'Cough or cold', hi: 'खांसी या जुकाम' },
    candidates: ['EA-3', 'I-1']
  },
  {
    id: 'breathlessness', icon: '😮‍💨', branch: 'respiratory',
    label: { en: 'Breathlessness', hi: 'सांस फूलना' },
    candidates: ['EA-4', 'EA-4.5']
  },
  {
    id: 'joint_pain', icon: '🦴', branch: 'pain',
    label: { en: 'Joint or body pain', hi: 'जोड़ों या शरीर में दर्द' },
    candidates: ['AAE-16', 'EC-6'],
    site: { en: 'joints', hi: 'जोड़ों' }
  },
  {
    id: 'headache', icon: '🤕', branch: 'pain',
    label: { en: 'Headache', hi: 'सिर दर्द' },
    candidates: ['AAB-79', 'AAB-96'],
    site: { en: 'head', hi: 'सिर' }
  },
  {
    id: 'abdominal_pain', icon: '🩻', branch: 'pain',
    label: { en: 'Stomach pain', hi: 'पेट में दर्द' },
    candidates: ['EB-7', 'EB-4'],
    site: { en: 'abdomen', hi: 'पेट' }
  },
  {
    id: 'bowel', icon: '🚽', branch: 'digestive',
    label: { en: 'Constipation, loose motion or piles', hi: 'कब्ज, दस्त या बवासीर' },
    candidates: ['EB-7', 'EE-3']
  },
  {
    id: 'skin', icon: '🩹', branch: 'skin',
    label: { en: 'Skin problem', hi: 'त्वचा की समस्या' },
    candidates: ['ABB-45', 'ED-4']
  },
  {
    id: 'weakness', icon: '😴', branch: 'general',
    label: { en: 'Weakness or tiredness', hi: 'कमज़ोरी या थकान' },
    candidates: ['AAB-26', 'AAB-65']
  },
  {
    id: 'other', icon: '❓', branch: 'general',
    label: { en: 'Something else', hi: 'कुछ और' },
    // Deliberately has no candidate concept: it routes to the curation queue rather
    // than forcing the narrative into a code that does not fit.
    candidates: []
  }
];

// ---------------------------------------------------------------------------
// History of presenting illness. `pain` implements SOCRATES; the other branches
// ask the equivalent structured questions for their complaint type.
// ---------------------------------------------------------------------------

const DURATION_OPTIONS = [
  { value: 'today', label: { en: 'Today', hi: 'आज' }, icon: '☀️' },
  { value: 'days', label: { en: 'A few days', hi: 'कुछ दिन' }, icon: '📅' },
  { value: 'weeks', label: { en: 'A few weeks', hi: 'कुछ हफ़्ते' }, icon: '🗓️' },
  { value: 'months', label: { en: 'Months or longer', hi: 'महीनों से' }, icon: '⏳' }
];

const FLOWS = {
  pain: [
    {
      id: 'onset', section: 'hpi', type: 'single',
      prompt: { en: 'How did the pain start?', hi: 'दर्द कैसे शुरू हुआ?' },
      options: [
        { value: 'sudden', label: { en: 'Suddenly', hi: 'अचानक' }, icon: '⚡', flags: ['sudden_onset'] },
        { value: 'gradual', label: { en: 'Slowly, over time', hi: 'धीरे-धीरे' }, icon: '🐢' }
      ]
    },
    {
      id: 'character', section: 'hpi', type: 'single',
      prompt: { en: 'What does the pain feel like?', hi: 'दर्द कैसा महसूस होता है?' },
      options: [
        { value: 'pressing', label: { en: 'Heavy or pressing', hi: 'भारी या दबाव जैसा' }, icon: '🪨', flags: ['pressing_pain'] },
        { value: 'burning', label: { en: 'Burning', hi: 'जलन जैसा' }, icon: '🔥' },
        { value: 'stabbing', label: { en: 'Sharp or stabbing', hi: 'तेज़ चुभन जैसा' }, icon: '🗡️' },
        { value: 'cramping', label: { en: 'Cramping', hi: 'मरोड़ जैसा' }, icon: '🌀' },
        { value: 'dull', label: { en: 'Dull ache', hi: 'हल्का दर्द' }, icon: '🫥' }
      ]
    },
    {
      id: 'radiation', section: 'hpi', type: 'single',
      prompt: { en: 'Does the pain travel anywhere else?', hi: 'क्या दर्द कहीं और फैलता है?' },
      options: [
        { value: 'arm_jaw', label: { en: 'To arm, shoulder or jaw', hi: 'बाँह, कंधे या जबड़े तक' }, icon: '💪', flags: ['radiation_arm_jaw'] },
        { value: 'back', label: { en: 'To the back', hi: 'पीठ तक' }, icon: '🔙' },
        { value: 'leg', label: { en: 'Down the leg', hi: 'टांग तक' }, icon: '🦵' },
        { value: 'none', label: { en: 'Stays in one place', hi: 'एक ही जगह रहता है' }, icon: '📍' }
      ]
    },
    {
      id: 'severity', section: 'hpi', type: 'scale',
      prompt: { en: 'How bad is the pain, from 1 to 10?', hi: 'दर्द कितना तेज़ है, 1 से 10 में?' },
      scale: { min: 1, max: 10, minLabel: { en: 'Mild', hi: 'हल्का' }, maxLabel: { en: 'Worst ever', hi: 'बहुत तेज़' } },
      severeAt: 8, severeFlag: 'severe_pain'
    },
    {
      id: 'duration', section: 'hpi', type: 'duration',
      prompt: { en: 'How long have you had this?', hi: 'यह कब से है?' },
      options: DURATION_OPTIONS
    },
    {
      id: 'aggravating', section: 'hpi', type: 'multi',
      prompt: { en: 'What makes it worse?', hi: 'किससे बढ़ता है?' },
      options: [
        { value: 'exertion', label: { en: 'Walking or exertion', hi: 'चलने या मेहनत से' }, icon: '🏃', flags: ['exertional'] },
        { value: 'food', label: { en: 'After eating', hi: 'खाने के बाद' }, icon: '🍽️' },
        { value: 'empty_stomach', label: { en: 'On empty stomach', hi: 'खाली पेट' }, icon: '🥣' },
        { value: 'movement', label: { en: 'Moving the joint', hi: 'जोड़ हिलाने से' }, icon: '🔄' },
        { value: 'cold', label: { en: 'Cold weather', hi: 'ठंड में' }, icon: '❄️' },
        { value: 'stress', label: { en: 'Stress or worry', hi: 'तनाव या चिंता' }, icon: '😟' },
        { value: 'nothing', label: { en: 'Nothing in particular', hi: 'कुछ खास नहीं' }, icon: '🤷' }
      ]
    },
    {
      id: 'associated', section: 'hpi', type: 'multi',
      prompt: { en: 'Do you also have any of these right now?', hi: 'क्या इनमें से कुछ भी अभी है?' },
      options: [
        { value: 'sweating', label: { en: 'Cold sweating', hi: 'ठंडा पसीना' }, icon: '💧', flags: ['sweating'] },
        { value: 'breathless', label: { en: 'Breathlessness', hi: 'सांस फूलना' }, icon: '😮‍💨', flags: ['breathless'] },
        { value: 'vomiting', label: { en: 'Vomiting', hi: 'उल्टी' }, icon: '🤮', flags: ['vomiting'] },
        { value: 'giddiness', label: { en: 'Giddiness or fainting', hi: 'चक्कर या बेहोशी' }, icon: '💫', flags: ['syncope'] },
        { value: 'fever', label: { en: 'Fever', hi: 'बुखार' }, icon: '🌡️', flags: ['fever'] },
        { value: 'swelling', label: { en: 'Swelling', hi: 'सूजन' }, icon: '🫄' },
        { value: 'none', label: { en: 'None of these', hi: 'इनमें से कुछ नहीं' }, icon: '🚫' }
      ]
    }
  ],

  digestive: [
    {
      id: 'duration', section: 'hpi', type: 'duration',
      prompt: { en: 'How long have you had this?', hi: 'यह कब से है?' },
      options: DURATION_OPTIONS
    },
    {
      id: 'bowel_pattern', section: 'hpi', type: 'single',
      prompt: { en: 'How are your motions?', hi: 'शौच कैसा रहता है?' },
      options: [
        { value: 'constipated', label: { en: 'Hard, difficult', hi: 'कड़ा, मुश्किल से' }, icon: '🪨' },
        { value: 'loose', label: { en: 'Loose or watery', hi: 'पतला या दस्त' }, icon: '💧' },
        { value: 'alternating', label: { en: 'Sometimes hard, sometimes loose', hi: 'कभी कड़ा, कभी पतला' }, icon: '🔄' },
        { value: 'normal', label: { en: 'Normal', hi: 'ठीक है' }, icon: '✅' }
      ]
    },
    {
      id: 'digestive_symptoms', section: 'hpi', type: 'multi',
      prompt: { en: 'Which of these do you have?', hi: 'इनमें से क्या-क्या है?' },
      options: [
        { value: 'sour_belching', label: { en: 'Sour belching', hi: 'खट्टी डकार' }, icon: '💨' },
        { value: 'heartburn', label: { en: 'Burning in chest', hi: 'छाती में जलन' }, icon: '🔥' },
        { value: 'bloating', label: { en: 'Bloating or gas', hi: 'पेट फूलना या गैस' }, icon: '🎈' },
        { value: 'nausea', label: { en: 'Nausea', hi: 'जी मिचलाना' }, icon: '🤢' },
        { value: 'blood_stool', label: { en: 'Blood in motion', hi: 'शौच में खून' }, icon: '🩸', flags: ['gi_bleed'] },
        { value: 'black_stool', label: { en: 'Black motion', hi: 'काला शौच' }, icon: '⚫', flags: ['gi_bleed'] },
        { value: 'weight_loss', label: { en: 'Losing weight', hi: 'वज़न घट रहा है' }, icon: '📉', flags: ['weight_loss'] },
        { value: 'none', label: { en: 'None of these', hi: 'इनमें से कुछ नहीं' }, icon: '🚫' }
      ]
    },
    {
      id: 'appetite', section: 'hpi', type: 'single',
      prompt: { en: 'How is your appetite?', hi: 'भूख कैसी है?' },
      options: [
        { value: 'reduced', label: { en: 'Reduced', hi: 'कम' }, icon: '🔽' },
        { value: 'normal', label: { en: 'Normal', hi: 'ठीक' }, icon: '✅' },
        { value: 'increased', label: { en: 'Increased', hi: 'ज़्यादा' }, icon: '🔼' }
      ]
    }
  ],

  fever: [
    {
      id: 'duration', section: 'hpi', type: 'duration',
      prompt: { en: 'How long have you had fever?', hi: 'बुखार कब से है?' },
      options: DURATION_OPTIONS
    },
    {
      id: 'fever_pattern', section: 'hpi', type: 'single',
      prompt: { en: 'How does the fever behave?', hi: 'बुखार कैसा रहता है?' },
      options: [
        { value: 'continuous', label: { en: 'Stays all day', hi: 'पूरे दिन रहता है' }, icon: '📈' },
        { value: 'intermittent', label: { en: 'Comes and goes', hi: 'आता-जाता है' }, icon: '🌊' },
        { value: 'evening', label: { en: 'Rises in the evening', hi: 'शाम को बढ़ता है' }, icon: '🌆' },
        { value: 'with_chills', label: { en: 'With shivering', hi: 'कंपकंपी के साथ' }, icon: '🥶' }
      ]
    },
    {
      id: 'fever_associated', section: 'hpi', type: 'multi',
      prompt: { en: 'Along with the fever, do you have any of these?', hi: 'बुखार के साथ इनमें से क्या है?' },
      options: [
        { value: 'neck_stiffness', label: { en: 'Neck stiffness', hi: 'गर्दन में अकड़न' }, icon: '🦒', flags: ['neck_stiffness'] },
        { value: 'confusion', label: { en: 'Confusion or drowsiness', hi: 'बेहोशी या सुस्ती' }, icon: '😵', flags: ['altered_sensorium'] },
        { value: 'rash', label: { en: 'Rash', hi: 'दाने' }, icon: '🔴' },
        { value: 'burning_urine', label: { en: 'Burning while passing urine', hi: 'पेशाब में जलन' }, icon: '🚻' },
        { value: 'cough', label: { en: 'Cough', hi: 'खांसी' }, icon: '😷' },
        { value: 'bleeding', label: { en: 'Bleeding from anywhere', hi: 'कहीं से खून आना' }, icon: '🩸', flags: ['bleeding'] },
        { value: 'none', label: { en: 'None of these', hi: 'इनमें से कुछ नहीं' }, icon: '🚫' }
      ]
    }
  ],

  respiratory: [
    {
      id: 'duration', section: 'hpi', type: 'duration',
      prompt: { en: 'How long have you had this?', hi: 'यह कब से है?' },
      options: DURATION_OPTIONS
    },
    {
      id: 'breathless_timing', section: 'hpi', type: 'single',
      prompt: { en: 'When do you feel short of breath?', hi: 'सांस कब फूलती है?' },
      options: [
        { value: 'rest', label: { en: 'Even while resting', hi: 'आराम करते हुए भी' }, icon: '🛏️', flags: ['dyspnoea_rest'] },
        { value: 'mild_exertion', label: { en: 'On walking a little', hi: 'थोड़ा चलने पर' }, icon: '🚶', flags: ['exertional'] },
        { value: 'heavy_exertion', label: { en: 'Only on heavy work', hi: 'भारी काम पर ही' }, icon: '🏋️' },
        { value: 'night', label: { en: 'Mostly at night', hi: 'ज़्यादातर रात में' }, icon: '🌙' },
        { value: 'not_breathless', label: { en: 'I am not breathless', hi: 'सांस नहीं फूलती' }, icon: '🚫' }
      ]
    },
    {
      id: 'cough_type', section: 'hpi', type: 'single',
      prompt: { en: 'What kind of cough is it?', hi: 'खांसी कैसी है?' },
      options: [
        { value: 'dry', label: { en: 'Dry cough', hi: 'सूखी खांसी' }, icon: '🍂' },
        { value: 'sputum', label: { en: 'With phlegm', hi: 'बलगम के साथ' }, icon: '💧' },
        { value: 'blood', label: { en: 'With blood', hi: 'खून के साथ' }, icon: '🩸', flags: ['haemoptysis'] },
        { value: 'no_cough', label: { en: 'No cough', hi: 'खांसी नहीं' }, icon: '🚫' }
      ]
    },
    {
      id: 'resp_associated', section: 'hpi', type: 'multi',
      prompt: { en: 'Do you also have any of these?', hi: 'क्या इनमें से कुछ भी है?' },
      options: [
        { value: 'wheeze', label: { en: 'Whistling sound in chest', hi: 'छाती में सीटी जैसी आवाज़' }, icon: '🎵' },
        { value: 'chest_pain', label: { en: 'Chest pain', hi: 'छाती में दर्द' }, icon: '🫀' },
        { value: 'fever', label: { en: 'Fever', hi: 'बुखार' }, icon: '🌡️', flags: ['fever'] },
        { value: 'blue_lips', label: { en: 'Lips turning blue', hi: 'होंठ नीले पड़ना' }, icon: '🫐', flags: ['cyanosis'] },
        { value: 'ankle_swelling', label: { en: 'Swelling of feet', hi: 'पैरों में सूजन' }, icon: '🦶' },
        { value: 'none', label: { en: 'None of these', hi: 'इनमें से कुछ नहीं' }, icon: '🚫' }
      ]
    }
  ],

  skin: [
    {
      id: 'duration', section: 'hpi', type: 'duration',
      prompt: { en: 'How long have you had this?', hi: 'यह कब से है?' },
      options: DURATION_OPTIONS
    },
    {
      id: 'skin_character', section: 'hpi', type: 'multi',
      prompt: { en: 'What is the skin like?', hi: 'त्वचा कैसी है?' },
      options: [
        { value: 'itching', label: { en: 'Itchy', hi: 'खुजली' }, icon: '🖐️' },
        { value: 'scaling', label: { en: 'Scaly or flaking', hi: 'पपड़ी उतरना' }, icon: '🍂' },
        { value: 'oozing', label: { en: 'Oozing or wet', hi: 'रिसाव' }, icon: '💧' },
        { value: 'discoloured', label: { en: 'Colour change', hi: 'रंग बदलना' }, icon: '🎨' },
        { value: 'painful', label: { en: 'Painful', hi: 'दर्द' }, icon: '⚡' }
      ]
    },
    {
      id: 'skin_spread', section: 'hpi', type: 'single',
      prompt: { en: 'Is it spreading?', hi: 'क्या यह फैल रहा है?' },
      options: [
        { value: 'spreading', label: { en: 'Yes, spreading', hi: 'हाँ, फैल रहा है' }, icon: '📈' },
        { value: 'same', label: { en: 'Staying the same', hi: 'वैसा ही है' }, icon: '➡️' },
        { value: 'improving', label: { en: 'Getting better', hi: 'ठीक हो रहा है' }, icon: '📉' }
      ]
    }
  ],

  general: [
    {
      id: 'duration', section: 'hpi', type: 'duration',
      prompt: { en: 'How long have you had this?', hi: 'यह कब से है?' },
      options: DURATION_OPTIONS
    },
    {
      id: 'complaint_detail', section: 'hpi', type: 'text',
      prompt: { en: 'Please describe the problem in your own words.', hi: 'अपनी समस्या अपने शब्दों में बताइए।' },
      help: { en: 'Speak naturally — you can also type.', hi: 'आराम से बोलिए — आप टाइप भी कर सकते हैं।' }
    },
    {
      id: 'general_associated', section: 'hpi', type: 'multi',
      prompt: { en: 'Do you also have any of these?', hi: 'क्या इनमें से कुछ भी है?' },
      options: [
        { value: 'fever', label: { en: 'Fever', hi: 'बुखार' }, icon: '🌡️', flags: ['fever'] },
        { value: 'weight_loss', label: { en: 'Losing weight', hi: 'वज़न घटना' }, icon: '📉', flags: ['weight_loss'] },
        { value: 'appetite_loss', label: { en: 'No appetite', hi: 'भूख न लगना' }, icon: '🍽️' },
        { value: 'giddiness', label: { en: 'Giddiness', hi: 'चक्कर' }, icon: '💫' },
        { value: 'breathless', label: { en: 'Breathlessness', hi: 'सांस फूलना' }, icon: '😮‍💨', flags: ['breathless'] },
        { value: 'none', label: { en: 'None of these', hi: 'इनमें से कुछ नहीं' }, icon: '🚫' }
      ]
    }
  ]
};

// ---------------------------------------------------------------------------
// Sections asked of every patient regardless of complaint.
// ---------------------------------------------------------------------------

const COMMON = [
  {
    id: 'past_history', section: 'past', type: 'multi',
    prompt: { en: 'Has a doctor ever told you that you have any of these?', hi: 'क्या डॉक्टर ने कभी इनमें से कुछ बताया है?' },
    options: [
      { value: 'diabetes', label: { en: 'Diabetes', hi: 'शुगर' }, icon: '🍬' },
      { value: 'hypertension', label: { en: 'High blood pressure', hi: 'हाई बी.पी.' }, icon: '💓' },
      { value: 'heart_disease', label: { en: 'Heart disease', hi: 'दिल की बीमारी' }, icon: '🫀', flags: ['known_cad'] },
      { value: 'asthma', label: { en: 'Asthma', hi: 'दमा' }, icon: '🌬️' },
      { value: 'thyroid', label: { en: 'Thyroid problem', hi: 'थायरॉइड' }, icon: '🦋' },
      { value: 'tb', label: { en: 'Tuberculosis', hi: 'टी.बी.' }, icon: '🫁' },
      { value: 'surgery', label: { en: 'Had an operation', hi: 'ऑपरेशन हुआ है' }, icon: '🔪' },
      { value: 'none', label: { en: 'None of these', hi: 'इनमें से कुछ नहीं' }, icon: '🚫' }
    ]
  },
  {
    id: 'medications', section: 'drugs', type: 'single',
    prompt: { en: 'Are you taking any medicines at present?', hi: 'क्या आप अभी कोई दवा ले रहे हैं?' },
    options: [
      { value: 'yes_regular', label: { en: 'Yes, regularly', hi: 'हाँ, रोज़' }, icon: '💊' },
      { value: 'yes_sometimes', label: { en: 'Yes, sometimes', hi: 'हाँ, कभी-कभी' }, icon: '🔄' },
      { value: 'no', label: { en: 'No', hi: 'नहीं' }, icon: '🚫' }
    ]
  },
  {
    id: 'medication_detail', section: 'drugs', type: 'text',
    prompt: { en: 'Which medicines? You can also scan the prescription later.', hi: 'कौन सी दवाइयाँ? आप पर्चा बाद में स्कैन भी कर सकते हैं।' },
    when: { q: 'medications', in: ['yes_regular', 'yes_sometimes'] }
  },
  {
    id: 'allergies', section: 'drugs', type: 'single',
    prompt: { en: 'Has any medicine ever caused a rash or reaction?', hi: 'क्या किसी दवा से कभी एलर्जी या दाने हुए हैं?' },
    options: [
      { value: 'yes', label: { en: 'Yes', hi: 'हाँ' }, icon: '⚠️', flags: ['drug_allergy'] },
      { value: 'no', label: { en: 'No', hi: 'नहीं' }, icon: '✅' },
      { value: 'unknown', label: { en: "Don't know", hi: 'पता नहीं' }, icon: '🤷' }
    ]
  },
  {
    id: 'allergy_detail', section: 'drugs', type: 'text',
    prompt: { en: 'Which medicine caused it?', hi: 'किस दवा से हुआ था?' },
    when: { q: 'allergies', in: ['yes'] }
  },
  {
    id: 'family_history', section: 'family', type: 'multi',
    prompt: { en: 'Does anyone in your family have these?', hi: 'क्या परिवार में किसी को ये हैं?' },
    options: [
      { value: 'diabetes', label: { en: 'Diabetes', hi: 'शुगर' }, icon: '🍬' },
      { value: 'hypertension', label: { en: 'High blood pressure', hi: 'हाई बी.पी.' }, icon: '💓' },
      { value: 'heart_disease', label: { en: 'Heart disease', hi: 'दिल की बीमारी' }, icon: '🫀' },
      { value: 'asthma', label: { en: 'Asthma', hi: 'दमा' }, icon: '🌬️' },
      { value: 'cancer', label: { en: 'Cancer', hi: 'कैंसर' }, icon: '🎗️' },
      { value: 'none', label: { en: 'None', hi: 'कोई नहीं' }, icon: '🚫' }
    ]
  },
  {
    id: 'personal_habits', section: 'personal', type: 'multi',
    prompt: { en: 'Do you use any of these?', hi: 'क्या आप इनमें से कुछ लेते हैं?' },
    options: [
      { value: 'tobacco_chew', label: { en: 'Chewing tobacco or gutka', hi: 'तंबाकू या गुटखा' }, icon: '🚬' },
      { value: 'smoking', label: { en: 'Smoking', hi: 'धूम्रपान' }, icon: '💨' },
      { value: 'alcohol', label: { en: 'Alcohol', hi: 'शराब' }, icon: '🍶' },
      { value: 'none', label: { en: 'None', hi: 'कुछ नहीं' }, icon: '🚫' }
    ]
  },
  {
    id: 'sleep', section: 'personal', type: 'single',
    prompt: { en: 'How is your sleep?', hi: 'नींद कैसी आती है?' },
    options: [
      { value: 'good', label: { en: 'Good', hi: 'अच्छी' }, icon: '😴' },
      { value: 'disturbed', label: { en: 'Disturbed', hi: 'टूटती है' }, icon: '🌙' },
      { value: 'poor', label: { en: 'Very little', hi: 'बहुत कम' }, icon: '😖' }
    ]
  }
];

// ---------------------------------------------------------------------------
// AYUSH mode — Dashavidha Pariksha, the ten-fold examination.
//
// Vaya (age) comes from registration and Vikriti is derived from the presenting
// complaint, so the kiosk asks the eight parameters a patient can self-report.
// Prakriti is assessed separately below because it needs several scored items,
// which is how it is taken clinically rather than as a single question.
// ---------------------------------------------------------------------------

const AYUSH = [
  {
    id: 'agni', section: 'ayush', pariksha: 'Ahara Shakti (Agni)', type: 'single',
    prompt: { en: 'How is your digestion after meals?', hi: 'खाना खाने के बाद पाचन कैसा रहता है?' },
    options: [
      { value: 'sama', label: { en: 'Digests well, feel light', hi: 'अच्छा पचता है, हल्का लगता है' }, icon: '✅', dosha: 'sama' },
      { value: 'manda', label: { en: 'Heavy, slow to digest', hi: 'भारीपन, देर से पचता है' }, icon: '🪨', dosha: 'kapha' },
      { value: 'tikshna', label: { en: 'Hungry again very soon', hi: 'जल्दी फिर भूख लगती है' }, icon: '🔥', dosha: 'pitta' },
      { value: 'vishama', label: { en: 'Sometimes good, sometimes not', hi: 'कभी ठीक, कभी नहीं' }, icon: '🌀', dosha: 'vata' }
    ]
  },
  {
    id: 'koshtha', section: 'ayush', pariksha: 'Koshtha', type: 'single',
    prompt: { en: 'How do your bowels usually move?', hi: 'शौच आमतौर पर कैसा होता है?' },
    options: [
      { value: 'mridu', label: { en: 'Soft, easy, daily', hi: 'नरम, आसानी से, रोज़' }, icon: '✅', dosha: 'pitta' },
      { value: 'madhyama', label: { en: 'Normal', hi: 'सामान्य' }, icon: '➡️', dosha: 'sama' },
      { value: 'krura', label: { en: 'Hard, needs effort', hi: 'कड़ा, ज़ोर लगाना पड़ता है' }, icon: '🪨', dosha: 'vata' }
    ]
  },
  {
    id: 'ahara', section: 'ayush', pariksha: 'Ahara (diet)', type: 'multi',
    prompt: { en: 'What do you eat most often?', hi: 'आप ज़्यादातर क्या खाते हैं?' },
    options: [
      { value: 'veg', label: { en: 'Vegetarian', hi: 'शाकाहारी' }, icon: '🥬' },
      { value: 'nonveg', label: { en: 'Non-vegetarian', hi: 'मांसाहारी' }, icon: '🍗' },
      { value: 'spicy', label: { en: 'Spicy food', hi: 'तीखा खाना' }, icon: '🌶️', dosha: 'pitta' },
      { value: 'oily', label: { en: 'Oily or fried', hi: 'तला हुआ' }, icon: '🍟', dosha: 'kapha' },
      { value: 'irregular', label: { en: 'Meals at irregular times', hi: 'खाने का समय तय नहीं' }, icon: '⏰', dosha: 'vata' }
    ]
  },
  {
    id: 'vyayama_shakti', section: 'ayush', pariksha: 'Vyayama Shakti', type: 'single',
    prompt: { en: 'How much physical work can you do without tiring?', hi: 'कितना शारीरिक काम बिना थके कर लेते हैं?' },
    options: [
      { value: 'pravara', label: { en: 'A full day of hard work', hi: 'पूरे दिन भारी काम' }, icon: '💪' },
      { value: 'madhyama', label: { en: 'Moderate work', hi: 'सामान्य काम' }, icon: '🚶' },
      { value: 'avara', label: { en: 'Tire very quickly', hi: 'जल्दी थक जाते हैं' }, icon: '😮‍💨' }
    ]
  },
  {
    id: 'sattva', section: 'ayush', pariksha: 'Sattva (mental strength)', type: 'single',
    prompt: { en: 'How do you usually handle stress or bad news?', hi: 'तनाव या बुरी खबर को आप कैसे संभालते हैं?' },
    options: [
      { value: 'pravara', label: { en: 'Stay calm', hi: 'शांत रहता हूँ' }, icon: '🧘' },
      { value: 'madhyama', label: { en: 'Upset for a while, then settle', hi: 'कुछ देर परेशान, फिर ठीक' }, icon: '🌤️' },
      { value: 'avara', label: { en: 'Get very disturbed', hi: 'बहुत घबरा जाता हूँ' }, icon: '😰' }
    ]
  },
  {
    id: 'satmya', section: 'ayush', pariksha: 'Satmya', type: 'single',
    prompt: { en: 'Which weather suits you least?', hi: 'कौन सा मौसम आपको कम सुहाता है?' },
    options: [
      { value: 'cold', label: { en: 'Cold weather', hi: 'ठंड' }, icon: '❄️', dosha: 'vata' },
      { value: 'hot', label: { en: 'Hot weather', hi: 'गर्मी' }, icon: '☀️', dosha: 'pitta' },
      { value: 'damp', label: { en: 'Damp or rainy', hi: 'नमी या बारिश' }, icon: '🌧️', dosha: 'kapha' },
      { value: 'none', label: { en: 'All suit me', hi: 'सब ठीक लगते हैं' }, icon: '✅' }
    ]
  },
  {
    id: 'sara_samhanana', section: 'ayush', pariksha: 'Sara / Samhanana', type: 'single',
    prompt: { en: 'How would you describe your build?', hi: 'आपका शरीर कैसा है?' },
    options: [
      { value: 'thin', label: { en: 'Thin, hard to gain weight', hi: 'दुबला, वज़न नहीं बढ़ता' }, icon: '🪶', dosha: 'vata' },
      { value: 'medium', label: { en: 'Medium, muscular', hi: 'मध्यम, मांसल' }, icon: '🏃', dosha: 'pitta' },
      { value: 'heavy', label: { en: 'Heavy, gains weight easily', hi: 'भारी, वज़न जल्दी बढ़ता है' }, icon: '🧸', dosha: 'kapha' }
    ]
  }
];

/**
 * Prakriti assessment. Each answer votes for a dosha; intake/engine.js tallies the
 * votes into a Vata/Pitta/Kapha profile. This is a screening instrument for the
 * physician to confirm, never a final constitutional diagnosis — the summary labels
 * it as provisional for exactly that reason.
 */
const PRAKRITI = [
  {
    id: 'prakriti_skin', section: 'ayush', pariksha: 'Prakriti', type: 'single',
    prompt: { en: 'How is your skin usually?', hi: 'आपकी त्वचा आमतौर पर कैसी रहती है?' },
    options: [
      { value: 'dry', label: { en: 'Dry, rough', hi: 'रूखी, खुरदरी' }, icon: '🍂', dosha: 'vata' },
      { value: 'warm', label: { en: 'Warm, reddish', hi: 'गर्म, लालिमा' }, icon: '🔥', dosha: 'pitta' },
      { value: 'oily', label: { en: 'Oily, smooth', hi: 'तैलीय, चिकनी' }, icon: '💧', dosha: 'kapha' }
    ]
  },
  {
    id: 'prakriti_temperament', section: 'ayush', pariksha: 'Prakriti', type: 'single',
    prompt: { en: 'Which describes you best?', hi: 'आप पर क्या सबसे सही बैठता है?' },
    options: [
      { value: 'quick', label: { en: 'Quick, restless mind', hi: 'तेज़, बेचैन मन' }, icon: '🌪️', dosha: 'vata' },
      { value: 'sharp', label: { en: 'Sharp, gets angry quickly', hi: 'तीखा, जल्दी गुस्सा' }, icon: '⚡', dosha: 'pitta' },
      { value: 'calm', label: { en: 'Calm, patient', hi: 'शांत, धैर्यवान' }, icon: '🪷', dosha: 'kapha' }
    ]
  },
  {
    id: 'prakriti_sleep', section: 'ayush', pariksha: 'Prakriti', type: 'single',
    prompt: { en: 'How do you sleep?', hi: 'आपकी नींद कैसी होती है?' },
    options: [
      { value: 'light', label: { en: 'Light, wakes easily', hi: 'हल्की, जल्दी खुल जाती है' }, icon: '🪶', dosha: 'vata' },
      { value: 'moderate', label: { en: 'Moderate', hi: 'ठीक-ठाक' }, icon: '🌙', dosha: 'pitta' },
      { value: 'deep', label: { en: 'Deep, hard to wake', hi: 'गहरी, मुश्किल से खुलती है' }, icon: '😴', dosha: 'kapha' }
    ]
  }
];

/**
 * Red flags. Evaluated after every answer against the flags raised so far; the
 * first match stops the interview and pushes the patient to the top of the
 * physician worklist. These are triage rules, not diagnoses — each one names the
 * concern so the triage nurse can see why the kiosk escalated.
 *
 * `all` = every flag must be present. `any` = at least one. `complaint` restricts
 * the rule to a chief complaint.
 */
const RED_FLAGS = [
  {
    id: 'acs',
    priority: 'CRITICAL',
    concern: { en: 'Possible heart attack — needs immediate assessment', hi: 'दिल का दौरा हो सकता है — तुरंत जाँच ज़रूरी' },
    complaint: ['chest_pain'],
    any: ['radiation_arm_jaw', 'sweating', 'breathless', 'syncope', 'exertional', 'known_cad'],
    action: { en: 'Take this patient to the emergency room now.', hi: 'इस मरीज़ को तुरंत आपातकालीन कक्ष ले जाएँ।' }
  },
  {
    id: 'severe_dyspnoea',
    priority: 'CRITICAL',
    concern: { en: 'Breathlessness at rest or blue lips', hi: 'आराम में सांस फूलना या होंठ नीले' },
    any: ['dyspnoea_rest', 'cyanosis'],
    action: { en: 'Check oxygen saturation immediately.', hi: 'तुरंत ऑक्सीजन स्तर जाँचें।' }
  },
  {
    id: 'meningitis',
    priority: 'CRITICAL',
    concern: { en: 'Fever with neck stiffness or altered consciousness', hi: 'बुखार के साथ गर्दन अकड़न या बेहोशी' },
    all: ['fever'],
    any: ['neck_stiffness', 'altered_sensorium'],
    action: { en: 'Assess for meningitis without delay.', hi: 'बिना देरी मेनिन्जाइटिस की जाँच करें।' }
  },
  {
    id: 'gi_bleed',
    priority: 'URGENT',
    concern: { en: 'Blood in motion or black stools', hi: 'शौच में खून या काला शौच' },
    any: ['gi_bleed'],
    action: { en: 'Check haemoglobin and vitals before routine queueing.', hi: 'सामान्य कतार से पहले हीमोग्लोबिन और वाइटल्स जाँचें।' }
  },
  {
    id: 'haemoptysis',
    priority: 'URGENT',
    concern: { en: 'Coughing blood', hi: 'खांसी में खून' },
    any: ['haemoptysis'],
    action: { en: 'Screen for tuberculosis and arrange a chest X-ray.', hi: 'टी.बी. जाँच और छाती का एक्स-रे कराएँ।' }
  },
  {
    id: 'bleeding_fever',
    priority: 'URGENT',
    concern: { en: 'Fever with bleeding — possible dengue', hi: 'बुखार के साथ खून आना — डेंगू हो सकता है' },
    all: ['fever', 'bleeding'],
    action: { en: 'Send an urgent platelet count.', hi: 'तुरंत प्लेटलेट काउंट भेजें।' }
  },
  {
    id: 'severe_pain_sudden',
    priority: 'URGENT',
    concern: { en: 'Severe pain of sudden onset', hi: 'अचानक शुरू हुआ तेज़ दर्द' },
    all: ['sudden_onset', 'severe_pain'],
    action: { en: 'Examine before routine queueing.', hi: 'सामान्य कतार से पहले जाँच करें।' }
  },
  {
    id: 'constitutional',
    priority: 'REVIEW',
    concern: { en: 'Weight loss with long-standing symptoms', hi: 'लंबे समय के लक्षणों के साथ वज़न घटना' },
    all: ['weight_loss'],
    action: { en: 'Consider malignancy and tuberculosis screening.', hi: 'कैंसर और टी.बी. जाँच पर विचार करें।' }
  }
];

module.exports = { LANGUAGES, CHIEF_COMPLAINTS, FLOWS, COMMON, AYUSH, PRAKRITI, RED_FLAGS, DURATION_OPTIONS };
