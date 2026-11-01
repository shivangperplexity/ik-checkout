/**
 * A best guess of gender from an Indian first name, only to pick the wording of a playful message
 * (abandoned checkout: "jaise woh chhod ke gayi / gaya"). 'm' | 'f' | null; null means "not sure": the caller
 * then uses the neutral wording, so a wrong guess is rarer than a missed one.
 */
const MALE = new Set(('aditya chaitanya krishna surya eklavya shiva rana raja abhimanyu sagar ravi hari rishi mani giri kavi ' +
  'nikhil rahul rohit amit sumit ankit mohit vikas vivek varun arun tarun karan arjun aman raman naman shivam shubham ' +
  'satyam sundaram vishal kunal nakul rohan sohan mohan rajan pawan gagan chetan ketan jatin nitin sachin yash harsh ' +
  'dev deep pradeep sandeep kuldeep mandeep jaideep gaurav saurabh rishabh abhishek akash prakash vikash ritesh hitesh ' +
  'mukesh suresh ramesh dinesh mahesh ganesh rajesh naresh umesh yogesh lokesh nilesh paresh brijesh kamlesh rakesh ' +
  'anand vinod pramod ashok alok vivek manoj saroj dhruv atharv parth siddharth sid aarav vihaan ayaan reyansh kabir ' +
  'arnav ishaan ansh vedant om tushar sameer zubair imran irfan salman faizan rizwan arif asif rahim karim farhan ' +
  'mohammed mohammad muhammad mohd ali hussain hasan aryan aryaman pranav madhav keshav raghav yuvraj prince ' +
  'manish ashish girish satish jagdish harish tanmay chinmay sanjay ajay vijay akshay abhay uday vinay pratik ' +
  'kartik kartikeya hardik sahil nikhilesh piyush ayush ankush anurag pankaj neeraj suraj dheeraj manav gautam ' +
  'shyam ram laxman bharat lakshya divyansh priyansh himanshu sudhanshu shashank mayank ' +
  'gurpreet harpreet manpreet jaspreet' /* Punjabi -preet names are mostly men without "kaur" */).split(/\s+/));
const FEMALE = new Set(('vidya priya priyanka riya diya siya kavya divya navya sanya ananya aanya anya aditi shruti smriti kriti ' +
  'neha sneha pooja puja anjali sonali rupali deepali shefali vaishali mitali pallavi shalini nandini kamini ' +
  'ankita nikita sarita kavita mamta namrata sangeeta geeta seeta sita rita lata swati preeti priti jyoti ' +
  'aarti arti bharti kirti shreya tanya tanvi khushi kashish simran kiran nupur noor ayesha fatima zainab sana ' +
  'heena hina meena reena teena isha disha nisha manisha asha usha rekha radha sudha shobha prabha kajal payal ' +
  'komal sonal minal pinal shital sheetal megha sakshi rashi rakhi sakhi palak anushka muskan ishita mehak ' +
  'mansi ritika radhika sneh pari avni vani rani gauri tripti trupti srishti sristi drishti vrinda pragya ' +
  'aishwarya pranjal kaur jasleen harleen gunjan suman poonam sonam chandni roshni rashmi lakshmi laxmi').split(/\s+/));

/* used by both: never guessed */
const AMBIG = new Set('sai kiran shashi santosh prem nikhat noor harmeet sukhmeet amarjeet paramjeet'.split(' '));

export function guessGender(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  if (first.length < 2 || AMBIG.has(first)) return null;
  if (/\bkaur\b/i.test(String(fullName))) return 'f';
  if (MALE.has(first)) return 'm';
  if (FEMALE.has(first)) return 'f';
  /* common endings */
  if (/(ika|ita|ini|isha|iya|eema|ina|shree|shri|preet|ali|avi|ani)$/.test(first)) return /preet$/.test(first) ? null : 'f';
  if (/(esh|ant|ender|inder|deep|veer|vir|raj|endra|ansh|ush|ik|an|ar|at|av|ul|it|ad|od|ir|am|al)$/.test(first)) return 'm';
  if (/a$/.test(first)) return null;   /* many men's names end in -a too (Krishna, Surya): don't guess */
  if (/(ee|i)$/.test(first)) return 'f';
  return null;
}
