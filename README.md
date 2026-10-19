# School Academic Result Management Portal

A full-featured, production-ready school result management system for recording, computing, and generating student academic report cards and class broadsheets.

> [!NOTE]
> This codebase is a clean duplicate preserving all original functionalities and backend logic (student roster, CA1/CA2/CA3 score entry, exam scoring, WAEC grading, class position calculation, broadsheets, fee tracking, affective traits, psychomotor skills, printable single-page A4 report cards with digital signatures, Supabase Auth/RLS, and Vercel serverless API routes).
> All school-specific details (name, logo, phone numbers, email, address, and signature) are blank and ready for customisation.

---

## Features

- **Student Roster Management**: Manage students with admission numbers, photos, gender, and classes.
- **Continuous Assessment (CA) & Exam Scoring**: Flexible 1, 2, or 3 CA components + Exam with auto-computed totals and WAEC grade calculations.
- **Class Broadsheet**: Comprehensive class overview with rankings, subject averages, and positions.
- **Printable Single-Page Report Cards**: Multiple design templates (Modern, Creative, Premium) optimized for single-sheet A4 printing with proprietor/principal signature.
- **School Fees & Resumption Tracking**: Optional fee breakdown and resumption date configuration.
- **Affective & Psychomotor Traits**: Track character, behavioral traits, and psychomotor skills.
- **Analytics & Grade Distribution**: Instant visual analytics on student and class performance.
- **Role-Based Access Control**: Secure Supabase Auth with Developer, Administrator, and Staff roles; Row-Level Security (RLS) policies protecting sensitive management settings.
- **PWA & Android App**: Mobile-first responsive web design with progressive web app support and native Android WebView wrapper.

---

## Classes Supported

| Level | Classes / Departments |
|---|---|
| **Senior Secondary (SS3)** | Science, Arts, Business |
| **Senior Secondary (SS2)** | Science, Arts, Business |
| **Senior Secondary (SS1)** | Science, Arts, Business |
| **Junior Secondary (JSS3)** | A, B |
| **Junior Secondary (JSS2)** | A, B |
| **Junior Secondary (JSS1)** | A, B |
| **Primary & Early Years** | Pre-school, Nursery, Basic 1 - 5 |

---

## Customisation Guide

### 1. School Information (Name, Address, Phone, Email, Motto)
- Open the portal and log in with an administrator account.
- Navigate to the **Settings** tab.
- Enter your school's official details:
  - **School Name**: e.g., `Excel International Academy`
  - **School Address**: e.g., `12 Knowledge Way, Ikeja, Lagos, Nigeria`
  - **Phone Number(s)**: e.g., `08012345678 / 09087654321`
  - **Email Address**: e.g., `info@excelschool.edu.ng`
  - **Motto / Slogan**: e.g., `Excellence and Integrity`
- Click **Save & Sync Settings**. These settings persist immediately to the Supabase `app_config` table and synchronize across all staff devices.

### 2. School Logo & Official Signature
- **School Logo**: Replace `school-logo.png` in the project root with your school badge/crest (PNG format recommended).
- **Signature**: Replace `proprietor-signature.png` in the project root with your principal or proprietor's transparent signature image.

---

## Supabase Database Setup

1. Create a new project in [Supabase](https://supabase.com).
2. Go to the **SQL Editor** in your Supabase project dashboard.
3. Open and run [`docs/school-portal-supabase-bootstrap.sql`](docs/school-portal-supabase-bootstrap.sql).
   - This script creates all required tables (`students`, `scores`, `traits`, `remarks`, `fees`, `published_subjects`, `app_config`, `academic_context`, `portal_access_config`, `staff_profiles`).
   - It sets up secure Row Level Security (RLS) policies and functions.
   - It initializes `app_config` with blank school placeholders ready for your custom inputs.
4. Copy your project's **Project URL** and **anon/publishable key** from **Project Settings > API**.

---

## Environment Variables

For deployment (e.g. on [Vercel](https://vercel.com)), configure the following environment variables:

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL (`https://xyz.supabase.co`) |
| `SUPABASE_ANON_KEY` | Your Supabase anon / publishable API key |
| `DEVELOPER_EMAIL` | Optional. Developer email for master maintenance access (defaults to `alabykhan@gmail.com`) |
| `SCHOOL_ADMIN_EMAIL` | Optional. Email for the school principal or administrator |
| `INITIAL_INVITE_CODE` | Optional. Default registration invite code for staff (defaults to `PORTAL2026`) |
| `RESULT_ALLOWED_ORIGINS` | Optional. Comma-separated list of allowed origins (e.g., custom domains) |

---

## Android App

The `android-app` folder contains a native Android WebView application with hardware print bridge for printing A4 report cards directly to PDF or physical printers.

Build the installable APK using Gradle:

```bash
gradle :android-app:assembleDebug
```

The APK will be generated at:
```text
android-app/build/outputs/apk/debug/android-app-debug.apk
```

---

## Deployment to Vercel

1. Push this duplicate repository to your GitHub account under a new repository name (e.g. `your-school-result-portal`).
2. Import the repository in [Vercel](https://vercel.com).
3. Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Vercel's Environment Variables settings.
4. Click **Deploy**.
