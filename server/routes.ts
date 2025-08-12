import type { Express } from "express";
import { createServer, type Server } from "http";
import { SupabaseStorage } from "./supabase-storage";
import bcrypt from "bcryptjs";
import session from "express-session";
import { loginSchema, changePasswordSchema, insertPatientSchema, insertTestPayloadSchema, insertTestTemplatePayloadSchema } from "@shared/schema";

declare module 'express-session' {
  interface SessionData {
    adminId?: number;
    username?: string;
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Ensure Express trusts proxy headers when deployed behind a proxy
  // and allow cookie settings to be controlled via env for local prod runs
  app.set("trust proxy", 1);
  // Initialize Supabase storage
  const storage = new SupabaseStorage();

  // Session configuration for Vercel/Serverless environments
  // In production, we need secure cookies, but for local development we don't
  const isProduction = process.env.NODE_ENV === 'production';
  const useSecureCookie = isProduction || (process.env.COOKIE_SECURE || "false").toLowerCase() === "true";
  
  app.use(session({
    secret: process.env.SESSION_SECRET || 'lab-management-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: useSecureCookie,
      // SameSite must be 'none' only when secure cookies are used in production
      sameSite: (useSecureCookie ? 'none' : 'lax'),
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    },
    // For Vercel deployment, we need to ensure sessions persist properly
    proxy: true
  }));

  // Auth middleware
  const requireAuth = (req: any, res: any, next: any) => {
    console.log('Auth check - Session ID:', req.sessionID);
    console.log('Auth check - Admin ID:', req.session?.adminId);
    console.log('Auth check - Session:', req.session);
    
    if (!req.session || !req.session.adminId) {
      console.log('Authentication failed - no valid session');
      return res.status(401).json({ message: "Authentication required" });
    }
    next();
  };

  // Login
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password, rememberMe } = loginSchema.parse(req.body);
      
      const admin = await storage.getAdminUserByUsername(username);
      if (!admin) {
        return res.status(401).json({ message: "Invalid credentials" });
      }

      const isValidPassword = await bcrypt.compare(password, admin.passwordHash);
      if (!isValidPassword) {
        return res.status(401).json({ message: "Invalid credentials" });
      }

      // Update last login
      await storage.updateLastLogin(admin.id);

      // Set session
      req.session.adminId = admin.id;
      req.session.username = admin.username;

      if (rememberMe) {
        req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
      }

      res.json({ 
        message: "Login successful",
        user: {
          id: admin.id,
          username: admin.username
        }
      });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // Logout
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ message: "Could not log out" });
      }
      res.json({ message: "Logout successful" });
    });
  });

  // Session validation endpoint (without auth middleware for debugging)
  app.get("/api/auth/session-info", (req, res) => {
    res.json({
      hasSession: !!req.session,
      sessionId: req.sessionID,
      adminId: req.session?.adminId,
      username: req.session?.username,
      cookieSettings: {
        secure: req.session?.cookie?.secure,
        httpOnly: req.session?.cookie?.httpOnly,
        sameSite: req.session?.cookie?.sameSite,
        maxAge: req.session?.cookie?.maxAge
      }
    });
  });

  // Session refresh endpoint
  app.post("/api/auth/refresh-session", (req, res) => {
    if (!req.session || !req.session.adminId) {
      return res.status(401).json({ message: "No valid session to refresh" });
    }
    
    // Touch the session to extend its lifetime
    req.session.touch();
    
    res.json({ 
      message: "Session refreshed",
      sessionId: req.sessionID,
      adminId: req.session.adminId
    });
  });

  // Get current user
  app.get("/api/auth/me", requireAuth, async (req, res) => {
    try {
      const admin = await storage.getAdminUser(req.session.adminId!);
      if (!admin) {
        return res.status(404).json({ message: "User not found" });
      }
      res.json({
        id: admin.id,
        username: admin.username
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Change password
  app.post("/api/auth/change-password", requireAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
      
      const admin = await storage.getAdminUser(req.session.adminId!);
      if (!admin) {
        return res.status(404).json({ message: "User not found" });
      }

      const isValidPassword = await bcrypt.compare(currentPassword, admin.passwordHash);
      if (!isValidPassword) {
        return res.status(401).json({ message: "Current password is incorrect" });
      }

      const newPasswordHash = await bcrypt.hash(newPassword, 10);
      await storage.updateAdminUserPassword(admin.id, newPasswordHash);

      res.json({ message: "Password changed successfully" });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // Verify password for ID editing
  app.post("/api/auth/verify-password", requireAuth, async (req, res) => {
    try {
      const { password } = req.body;
      
      const admin = await storage.getAdminUser(req.session.adminId!);
      if (!admin) {
        return res.status(404).json({ message: "User not found" });
      }

      const isValidPassword = await bcrypt.compare(password, admin.passwordHash);
      res.json({ valid: isValidPassword });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Dashboard stats
  app.get("/api/dashboard/stats", requireAuth, async (req, res) => {
    try {
      const [todayTests, totalPatients, pendingReports, criticalResults] = await Promise.all([
        storage.getTodayTestsCount(),
        storage.getTotalPatientsCount(),
        storage.getPendingReportsCount(),
        storage.getCriticalResultsCount()
      ]);

      res.json({
        todayTests,
        totalPatients,
        pendingReports,
        criticalResults
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Patients
  app.get("/api/patients", requireAuth, async (req, res) => {
    try {
      const patients = await storage.getAllPatients();
      res.json(patients);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete("/api/patients/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deletePatient(parseInt(id));
      res.json({ message: "Patient deleted successfully" });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  app.get("/api/patients/next-id", requireAuth, async (req, res) => {
    try {
      const nextId = await storage.getNextPatientId();
      res.json({ nextId });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/patients", requireAuth, async (req, res) => {
    try {
      const patientData = insertPatientSchema.parse(req.body);
      
      // Check if patient ID already exists
      const existingPatient = await storage.getPatientByPatientId(patientData.patientId);
      if (existingPatient) {
        return res.status(400).json({ message: "Patient ID already exists" });
      }
      
      patientData.createdBy = req.session.adminId;
      patientData.modifiedBy = req.session.adminId;
      
      const patient = await storage.createPatient(patientData);
      res.json(patient);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  app.put("/api/patients/:id/patient-id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { newPatientId } = req.body;
      
      await storage.updatePatientId(parseInt(id), newPatientId, req.session.adminId!);
      res.json({ message: "Patient ID updated successfully" });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // Tests
  app.get("/api/tests", requireAuth, async (req, res) => {
    try {
      const tests = await storage.getAllTests();
      res.json(tests);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.delete("/api/tests/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteTest(parseInt(id));
      res.json({ message: "Test deleted successfully" });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // Get tests with patient information for reports
  app.get("/api/tests/with-patients", requireAuth, async (req, res) => {
    try {
      const testsWithPatients = await storage.getAllTestsWithPatients();
      res.json(testsWithPatients);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  // Get tests for specific patient
  app.get("/api/patients/:patientId/tests", requireAuth, async (req, res) => {
    try {
      const { patientId } = req.params;
      const tests = await storage.getTestsByPatient(parseInt(patientId));
      res.json(tests);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/tests/next-id", requireAuth, async (req, res) => {
    try {
      const nextId = await storage.getNextTestId();
      res.json({ nextId });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/tests", requireAuth, async (req, res) => {
    try {
      const payload = insertTestPayloadSchema.parse(req.body);
      
      // Check if test ID already exists
      const existingTest = await storage.getTestByTestId(payload.testId);
      if (existingTest) {
        return res.status(400).json({ message: "Test ID already exists" });
      }
      
      const toInsert = {
        testId: payload.testId,
        patientId: payload.patientId ?? null,
        testType: payload.testType,
        testResults: JSON.stringify(payload.testResults ?? {}),
        normalRanges: JSON.stringify(payload.normalRanges ?? {}),
        flags: payload.flags != null ? JSON.stringify(payload.flags) : null,
        status: payload.status ?? "completed",
        testDate: payload.testDate ?? null,
        testTime: payload.testTime ?? null,
        performedBy: req.session.adminId ?? null,
        modifiedBy: req.session.adminId ?? null,
      } as const;

      const test = await storage.createTest(toInsert as any);
      res.json(test);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // Test templates (builder)
  app.get("/api/test-templates", requireAuth, async (_req, res) => {
    try {
      const templates = await storage.getAllTestTemplates();
      res.json(templates);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/test-templates/:testType", requireAuth, async (req, res) => {
    try {
      const { testType } = req.params;
      const template = await storage.getTestTemplateByType(testType);
      if (!template) return res.status(404).json({ message: "Template not found" });
      res.json(template);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/test-templates", requireAuth, async (req, res) => {
    try {
      const payload = insertTestTemplatePayloadSchema.parse(req.body);
      const saved = await storage.upsertTestTemplate({
        testType: payload.testType,
        parameters: JSON.stringify(payload.parameters ?? {}),
      } as any);
      res.json(saved);
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  app.put("/api/tests/:id/test-id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { newTestId } = req.body;
      
      await storage.updateTestId(parseInt(id), newTestId, req.session.adminId!);
      res.json({ message: "Test ID updated successfully" });
    } catch (error: any) {
      res.status(400).json({ message: error.message });
    }
  });

  // Audit logs
  app.get("/api/audit/id-changes", requireAuth, async (req, res) => {
    try {
      const logs = await storage.getIdChangeLogs();
      res.json(logs);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
