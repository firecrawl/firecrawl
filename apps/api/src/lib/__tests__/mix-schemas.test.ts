import { mixSchemaObjects } from "../extract/helpers/mix-schema-objs";
import { transformArrayToObject } from "../extract/helpers/transform-array-to-obj";

describe("mixSchemaObjects function", () => {
  it("should mix kyb schema (id: 1)", async () => {
    const originalSchema = {
      type: "object",
      properties: {
        business: {
          type: "object",
          properties: {
            name: { type: "string" },
            registration_number: { type: "string" },
            tax_id: { type: "string" },
            type: { type: "string" },
            industry: { type: "string" },
            address: {
              type: "object",
              properties: {
                street: { type: "string" },
                city: { type: "string" },
                state: { type: "string" },
                country: { type: "string" },
                postal_code: { type: "string" },
              },
            },
            incorporation_date: { type: "string", format: "date" },
            phone: { type: "string" },
            email: { type: "string", format: "email" },
          },
        },
        owners: {
          type: "array",
          items: {
            type: "object",
            properties: {
              full_name: { type: "string" },
              role: { type: "string" },
              address: {
                type: "object",
                properties: {
                  street: { type: "string" },
                  city: { type: "string" },
                  state: { type: "string" },
                  country: { type: "string" },
                  postal_code: { type: "string" },
                },
              },
              phone: { type: "string" },
              email: { type: "string", format: "email" },
            },
          },
        },
      },
    };

    const singleAnswerResult = {
      business: {
        name: "Revolut Ltd",
        registration_number: "08804411",
        tax_id: "",
        type: "Private limited company",
        industry: "Other information technology service activities",
        address: {
          street: "7 Westferry Circus",
          city: "London",
          state: "",
          country: "England",
          postal_code: "E14 4HD",
        },
        incorporation_date: "2013-12-06",
        phone: "",
        email: "",
      },
    };

    const multiEntityResult = {
      owners: [
        {
          full_name: "Thomas Bruce Hambrett",
          role: "Secretary",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "Caroline Louise Britton",
          role: "Director",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "Martin James Gilbert",
          role: "Director",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "Michael Sidney Sherwood",
          role: "Director",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "John Phimister Sievwright",
          role: "Director",
          ownership_percentage: "",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "Nikolay Storonsky",
          role: "Director",
          ownership_percentage: "",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "Dan Teodosiu",
          role: "Director",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "Vladyslav Yatsenko",
          role: "Director",
          ownership_percentage: "",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
      ],
    };

    const finalResult = await mixSchemaObjects(
      originalSchema,
      singleAnswerResult,
      multiEntityResult,
    );

    expect(finalResult).toEqual({
      business: {
        name: "Revolut Ltd",
        registration_number: "08804411",
        tax_id: "",
        type: "Private limited company",
        industry: "Other information technology service activities",
        address: {
          street: "7 Westferry Circus",
          city: "London",
          state: "",
          country: "England",
          postal_code: "E14 4HD",
        },
        incorporation_date: "2013-12-06",
        phone: "",
        email: "",
      },
      owners: [
        {
          full_name: "Thomas Bruce Hambrett",
          role: "Secretary",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "Caroline Louise Britton",
          role: "Director",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "Martin James Gilbert",
          role: "Director",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "Michael Sidney Sherwood",
          role: "Director",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "John Phimister Sievwright",
          role: "Director",
          ownership_percentage: "",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "Nikolay Storonsky",
          role: "Director",
          ownership_percentage: "",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "Dan Teodosiu",
          role: "Director",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
        {
          full_name: "Vladyslav Yatsenko",
          role: "Director",
          ownership_percentage: "",
          address: {
            street: "7 Westferry Circus",
            city: "Canary Wharf",
            state: "London",
            country: "England",
            postal_code: "E14 4HD",
          },
          phone: "",
          email: "",
        },
      ],
    });
  });

  it("should mix lawyers schema (id: 29)", async () => {
    const originalSchema = {
      type: "object",
      properties: {
        lawyers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: ["string", "null"], format: "email" },
              title: { type: ["string", "null"] },
              phone_number: { type: ["string", "null"], alias: "phone-number" },
              practice_areas: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    area: { type: "string" },
                  },
                },
                alias: "practice-areas",
              },
            },
          },
        },
      },
    };

    const multiEntityResult = {
      lawyers: [
        {
          name: "Phillip Galyen",
          email: "pgalyen@galyen.com",
          title: "President and CEO",
          "phone-number": "(844) 698-0233",
          "practice-areas": [
            {
              area: "Personal Injury",
            },
          ],
        },
        {
          name: "James Bridge",
          email: "jbridge@galyen.com",
          title: "COO & Firm Managing Attorney",
          "phone-number": "(844) 698-0233",
          "practice-areas": [
            {
              area: "Personal Injury",
            },
          ],
        },
        {
          name: "Stephen C. Maxwell",
          email: "smaxwell@galyen.com",
          title: "Personal Injury Trial Attorney",
          "phone-number": "(844) 698-0233",
          "practice-areas": [
            {
              area: "Personal Injury",
            },
          ],
        },
        {
          name: "Scott Robelen",
          email: "srobelen@galyen.com",
          title: "Personal Injury Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Personal Injury",
            },
          ],
        },
        {
          name: "Kern A. Lewis",
          email: "klewis@galyen.com",
          title: "Personal Injury Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Personal Injury",
            },
          ],
        },
        {
          name: "Steven Pierret",
          email: "spierret@galyen.com",
          title: "Personal Injury Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Personal Injury",
            },
          ],
        },
        {
          name: "Michael Galyen",
          email: "mgalyen@galyen.com",
          title: "Executive Vice President - Litigation Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Personal Injury",
            },
          ],
        },
        {
          name: "H. John Gutierrez",
          email: "jgutierrez@galyen.com",
          title: "Personal Injury Lawyer",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Personal Injury",
            },
          ],
        },
        {
          name: "Daniel P. Sullivan",
          email: "dsullivan@galyen.com",
          title: "Personal Injury Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Personal Injury",
            },
          ],
        },
        {
          name: "Ana Lee",
          email: "alee@galyen.com",
          title: "Personal Injury Attorney",
          "phone-number": "(844) 402-4530",
          "practice-areas": [
            {
              area: "Personal Injury",
            },
          ],
        },
        {
          name: "Michael Raymond Cramer",
          email: "mcramer@galyen.com",
          title: "Of Counsel",
          "phone-number": "(844) 698-0233",
          "practice-areas": [
            {
              area: "Business Law",
            },
            {
              area: "Civil and Commercial Litigation",
            },
            {
              area: "Employment Law",
            },
            {
              area: "Corporate Law",
            },
            {
              area: "Construction Law",
            },
            {
              area: "Real Estate",
            },
            {
              area: "Civil Defense",
            },
            {
              area: "Estate Planning",
            },
          ],
        },
        {
          name: "Benton Gann",
          email: "bgann@galyen.com",
          title: "Personal Injury Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Personal Injury",
            },
          ],
        },
        {
          name: "Shane F. Langston",
          email: "slangston@galyen.com",
          title: "Personal Injury Litigation",
          "phone-number": "(844) 402-4530",
          "practice-areas": [
            {
              area: "Personal Injury Litigation",
            },
          ],
        },
        {
          name: "Rebecca M. Langston",
          email: "rlangston@galyen.com",
          title: "Personal Injury Litigation",
          "phone-number": "(844) 402-4530",
          "practice-areas": [
            {
              area: "Personal Injury Litigation",
            },
          ],
        },
        {
          name: "David Klemm",
          email: "dklemm@galyen.com",
          title: "Personal Injury Trial Lawyer",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Personal Injury Trial Lawyer",
            },
          ],
        },
        {
          name: "Tyler D. Baker",
          email: "tbaker@galyen.com",
          title: "Personal Injury Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Personal Injury",
            },
          ],
        },
        {
          name: "Clint Lee",
          email: "clee@galyen.com",
          title: "Catastrophic Injury Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Catastrophic Injury",
            },
          ],
        },
        {
          name: "R. Keith Spencer",
          email: "rkspencer@galyen.com",
          title: "Family Law Attorney",
          "phone-number": "(844) 698-0233",
          "practice-areas": [
            {
              area: "Family Law",
            },
          ],
        },
        {
          name: "Gene Leposki",
          email: "gleposki@galyen.com",
          title: "Family Law Attorney",
          "phone-number": "(844) 698-0233",
          "practice-areas": [
            {
              area: "Family Law",
            },
          ],
        },
        {
          name: "Teresa Sanchez",
          email: "tsanchez@galyen.com",
          title: "Managing Attorney of the Family Law Department",
          "phone-number": "(844) 698-0233",
          "practice-areas": [
            {
              area: "Family Law",
            },
          ],
        },
        {
          name: "Paul Kennedy",
          email: "pkennedy@galyen.com",
          title: "Family Law Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Family Law",
            },
          ],
        },
        {
          name: "Danielle Cortez-Harper",
          email: "dharper@galyen.com",
          title: "Family Law Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Family Law",
            },
          ],
        },
        {
          name: "Jane Mapes",
          email: "jmapes@galyen.com",
          title: "Family Law Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Family Law",
            },
          ],
        },
        {
          name: "Juliette Steffe",
          email: "jsteffe@galyen.com",
          title: "Family Law Attorney",
          "phone-number": "(817) 263-3000",
          "practice-areas": [
            {
              area: "Family Law",
            },
          ],
        },
        {
          name: "Anna Nika",
          email: "anika@galyen.com",
          title: "Family Law Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Family Law",
            },
          ],
        },
        {
          name: "Lori Shannon",
          email: "lshannon@galyen.com",
          title: "Family Law Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Family Law",
            },
          ],
        },
        {
          name: "Michael Livens",
          email: "mlivens@galyen.com",
          title: "Family Law Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Family Law",
            },
          ],
        },
        {
          name: "Jennifer Scherf",
          email: "jscherf@galyen.com",
          title: "Family Law Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Family Law",
            },
          ],
        },
        {
          name: "Allen Griffin",
          email: "agriffin@galyen.com",
          title: "Family Law Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Family Law",
            },
          ],
        },
        {
          name: "Ian Croall",
          email: "icroall@galyen.com",
          title:
            "Vice President & Managing Attorney, Social Security Disability",
          "phone-number": "(844) 698-0233",
          "practice-areas": [
            {
              area: "Social Security Disability",
            },
          ],
        },
        {
          name: "Kim C. Smith",
          email: "ksmith@galyen.com",
          title: "Managing Attorney, Workers’ Compensation",
          "phone-number": "(844) 698-0233",
          "practice-areas": [
            {
              area: "Workers’ Compensation",
            },
          ],
        },
        {
          name: "J. C. Bailey III",
          email: "jcbailey@galyen.com",
          title: "Estate Planning, Probate, Wills & Business Law",
          "phone-number": "(844) 698-0233",
          "practice-areas": [
            {
              area: "Estate Planning",
            },
            {
              area: "Probate",
            },
            {
              area: "Wills",
            },
            {
              area: "Business Law",
            },
          ],
        },
        {
          name: "John Robinson",
          email: "jrobinson@galyen.com",
          title: "Criminal Law Attorney",
          "phone-number": "(844) 698-0233",
          "practice-areas": [
            {
              area: "Criminal Law",
            },
          ],
        },
        {
          name: "Michael Raymond Cramer",
          email: "mcramer@galyen.com",
          title: "Of Counsel",
          "phone-number": "(844) 698-0233",
          "practice-areas": [
            {
              area: "Business Law",
            },
            {
              area: "Civil and Commercial Litigation",
            },
            {
              area: "Employment Law",
            },
            {
              area: "Corporate Law",
            },
            {
              area: "Construction Law",
            },
            {
              area: "Real Estate",
            },
            {
              area: "Civil Defense",
            },
            {
              area: "Estate Planning",
            },
          ],
        },
        {
          name: "Paul F. Wieneskie",
          email: "pwieneskie@galyen.com",
          title: "Civil Appellate Attorney",
          "phone-number": "(844) 698-0233",
          "practice-areas": [
            {
              area: "Civil Appellate Law",
            },
          ],
        },
        {
          name: "Claudia Cubias",
          email: "ccubias@galyen.com",
          title: "Immigration Attorney",
          "phone-number": "(844) 402-2992",
          "practice-areas": [
            {
              area: "Immigration Law",
            },
          ],
        },
        {
          name: "Katherine Hawkins",
          email: "khawkins@galyen.com",
          title: "Immigration Attorney",
          "phone-number": "",
          "practice-areas": [
            {
              area: "Immigration Law",
            },
          ],
        },
      ],
    };

    const singleAnswerResult = {};

    const finalResult = await mixSchemaObjects(
      originalSchema,
      singleAnswerResult,
      multiEntityResult,
    );

    expect(finalResult).toEqual(multiEntityResult);
  });

  it("shoud spread (id: 26)", async () => {
    const res1 = {
      products: [
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res2 = {
      products: [
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res3 = {
      products: [
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res4 = {
      products: [
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res5 = {
      products: [
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res6 = {
      products: [
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const res7 = {
      products: [
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const results = [res1, res2, res3, res4, res5, res6, res7];

    const originalSchema = {
      type: "object",
      properties: {
        products: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              price: { type: "string" },
              description: { type: "string" },
            },
          },
        },
      },
    };

    console.log(await transformArrayToObject(originalSchema, results));

    const singleAnswerResult = {};
    const multiEntityResult = {
      products: [
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
        {
          name: "סיר Neon",
          price: "99.90 ₪",
          description:
            "סיר מסדרת Neon גוף הכלי עשוי אלומיניום להולכת חום מהירה ואחידה ולחיסכון בזמן ואנרגיה סיר בציפוי נון סטיק למניעת הדבקות המזון, לשימוש מופחת בשמן ולניקוי קל ונוח. מתאים לכל סוגי הכיריים, מתאים לאינדוקציה מתאים לשטיפה במדיח. מתאים לשימוש כסיר אורז, סיר פסטה, סיר מרק, סיר למגוון תבשילים. סיר 28 ס”מ | 7.1 ליטר התמונה להמחשה בלבד. הצבע בתמונה עשוי להיות שונה מהמציאות",
        },
      ],
    };

    const finalResult = await mixSchemaObjects(
      originalSchema,
      singleAnswerResult,
      multiEntityResult,
    );

    expect(finalResult).toEqual(multiEntityResult);
  });

  it("should spread (id: 29)", async () => {
    const originalSchema = {
      type: "object",
      properties: {
        is_active: { type: "boolean" },
        is_partner: { type: "boolean" },
        is_msp: { type: "boolean" },
        is_auditor: { type: "boolean" },
        is_vciso: { type: "boolean" },
        offers_soc_2: { type: "boolean" },
        offers_iso_27001: { type: "boolean" },
        offers_cmmc: { type: "boolean" },
        has_soc_2_cert: { type: "boolean" },
        offers_office365: { type: "boolean" },
        offers_endpoint_security: { type: "boolean" },
      },
    };

    const singleAnswerResult = {
      is_active: true,
      is_partner: true,
      is_msp: true,
      is_auditor: false,
      is_vciso: false,
      offers_soc_2: true,
      offers_iso_27001: false,
      offers_cmmc: false,
      has_soc_2_cert: false,
      offers_office365: true,
      offers_endpoint_security: false,
    };
    const multiEntityResult = {};

    const finalResult = await mixSchemaObjects(
      originalSchema,
      singleAnswerResult,
      multiEntityResult,
    );

    expect(finalResult).toEqual(singleAnswerResult);
  });

  it("should handle empty objects correctly (id: 30)", async () => {
    const originalSchema = {
      type: "object",
      properties: {
        business_details: {
          type: "object",
          properties: {
            name: { type: "string" },
            years_in_operation: { type: "string" },
            services_offered: {
              type: "array",
              items: { type: "string" },
            },
            experience_highlights: { type: "string" },
          },
          required: ["name"],
        },
        management: {
          type: "object",
          properties: {
            owner_name: { type: "string" },
            credentials: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        contact_information: {
          type: "object",
          properties: {
            address: { type: "string" },
            phone: { type: "string" },
          },
        },
        reputation: {
          type: "object",
          properties: {
            client_feedback: { type: "string" },
            operational_quality: { type: "string" },
          },
        },
      },
      required: ["business_details"],
    };

    const singleAnswerResult = {
      business_details: {
        name: "Red Hill Mobility Group",
        years_in_operation: "12 years",
        services_offered: [
          "Recovery equipment for military",
          "Vehicle mobility solutions",
          "Product development for military vehicles",
        ],
        experience_highlights:
          "More than 12 years of combined experience overseas on over 25 active combat deployments.",
      },
      management: {
        owner_name: "",
        credentials: [],
      },
      contact_information: {
        address: "659 Shell Drive, Spring Lake, NC 28390",
        phone: "910-638-7836",
      },
      reputation: {
        client_feedback: "",
        operational_quality: "",
      },
    };

    const multiEntityResult = {};

    const finalResult = await mixSchemaObjects(
      originalSchema,
      singleAnswerResult,
      {},
    );

    expect(finalResult).toEqual(singleAnswerResult);
  });

  it("should return single answer result when multi entity is undefined", async () => {
    const originalSchema = {
      type: "object",
      properties: {
        business_details: {
          type: "object",
          properties: {
            name: { type: "string" },
            years_in_operation: { type: "string" },
            services_offered: {
              type: "array",
              items: { type: "string" },
            },
            experience_highlights: { type: "string" },
          },
          required: ["name"],
        },
        management: {
          type: "object",
          properties: {
            owner_name: { type: "string" },
            credentials: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        contact_information: {
          type: "object",
          properties: {
            address: { type: "string" },
            phone: { type: "string" },
          },
        },
        reputation: {
          type: "object",
          properties: {
            client_feedback: { type: "string" },
            operational_quality: { type: "string" },
          },
        },
      },
      required: ["business_details"],
    };

    const singleAnswerResult = {
      business_details: {
        name: "Red Hill Mobility Group",
        years_in_operation: "12 years",
        services_offered: [
          "Recovery equipment for military",
          "Vehicle mobility solutions",
          "Product development for military vehicles",
        ],
        experience_highlights:
          "More than 12 years of combined experience overseas on over 25 active combat deployments.",
      },
      management: {
        owner_name: "",
        credentials: [],
      },
      contact_information: {
        address: "659 Shell Drive, Spring Lake, NC 28390",
        phone: "910-638-7836",
      },
      reputation: {
        client_feedback: "",
        operational_quality: "",
      },
    };

    const finalResult = await mixSchemaObjects(
      originalSchema,
      singleAnswerResult,
      {},
    );

    expect(finalResult).toEqual(singleAnswerResult);
  });
});
