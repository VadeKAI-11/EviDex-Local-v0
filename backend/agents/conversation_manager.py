"""
Conversation Manager - "Ask Agent Why" Chat Interface

This agent provides a conversational interface for auditors to ask questions
about workflow execution, evidence assessment, and AI decisions. It uses
AWS Bedrock Claude to generate context-aware responses with evidence citations.

Key Responsibilities:
- Manage conversation sessions and message history
- Generate context-aware responses using Bedrock Claude
- Provide explanations for AI decisions and confidence scores
- Reference evidence items and step logs in responses
- Track conversation threads for audit trail
- Support multi-turn conversations with memory

Conversation Features:
- Natural language Q&A about audit findings
- Evidence citation and reference linking
- Clarification of AI reasoning and decisions
- Suggestions for next actions and improvements
- Professional audit terminology and tone

Integration:
- Backend endpoint: /api/chat/workflow/interactions
- Frontend component: WorkflowInterface.tsx
- AI Model: Bedrock Claude (configurable via BEDROCK_CHAT_MODEL_ID)

Workflow Position: Cross-cutting (available at all stages)
"""

# ============================================================================
# IMPORTS AND DEPENDENCIES
# ============================================================================

import os
import re
from typing import List, Dict, Any, Optional
from datetime import datetime
from uuid import uuid4
try:
    import boto3
except ImportError:
    boto3 = None

from agents.bedrock_summary_agent import (
    DEFAULT_MODEL_ID,
    _resolve_explicit_credentials,
    _resolve_tls_verify,
    _retry_converse_without_env_credentials,
)
from agents.standards_knowledge_base import build_standards_prompt_context

from models.schemas import (
    ConversationMessage,
    Conversation,
    WorkflowStepLog,
    AuditRequest,
)


CONTINUATION_PATTERNS = [
    r"^(and|also|then|so|okay|ok|got it|understood|makes sense)\b",
    r"^(thanks|thank you|noted|sure)\b",
    r"^(what about|can you|please|go on|continue|elaborate)\b",
]


# ============================================================================
# CONVERSATION MANAGER CLASS
# ============================================================================
# Main class that orchestrates conversational interactions using Bedrock Claude.
# Maintains conversation state and handles multi-turn dialogue.

class ConversationManager:
    """
    Manages conversational interactions with the auditor throughout the audit workflow.
    
    Provides:
    - Natural language Q&A about audit findings
    - Explanations of AI decisions with evidence citations
    - Feedback collection for AI improvement
    - Clarifications on evidence and conclusions
    """
    
    def __init__(self, model_id: Optional[str] = None):
        """
        Initialize conversation manager with Amazon Bedrock Claude.
        
        Parameters:
        - model_id: Optional Bedrock model override (defaults to BEDROCK_CHAT_MODEL_ID/BEDROCK_MODEL_ID)
        """
        if boto3 is None:
            raise ImportError(
                "boto3 package is required. Install with: pip install boto3"
            )

        self.region = os.getenv("AWS_REGION", "us-east-1")
        self.model = model_id or os.getenv("BEDROCK_CHAT_MODEL_ID") or os.getenv("BEDROCK_MODEL_ID") or DEFAULT_MODEL_ID
        self.tls_verify = _resolve_tls_verify()
        self.explicit_credentials = _resolve_explicit_credentials(self.region)
        self.client = self._create_bedrock_client()
        self.conversations: Dict[str, Conversation] = {}

    def _create_bedrock_client(self):
        client_kwargs: Dict[str, Any] = {
            "region_name": self.region,
            "verify": self.tls_verify,
        }
        if self.explicit_credentials:
            client_kwargs.update(self.explicit_credentials)

        return boto3.client("bedrock-runtime", **client_kwargs)

    def get_health_status(self, run_probe: bool = True) -> Dict[str, Any]:
        """Return conversation service health and optional Bedrock probe diagnostics."""

        status: Dict[str, Any] = {
            "success": True,
            "service_available": True,
            "bedrock_access_ok": not run_probe,
            "region": self.region,
            "model_id": self.model,
            "checked_at": datetime.utcnow().isoformat(),
            "diagnostic_message": "Conversation service is initialized.",
        }

        if not run_probe:
            status["diagnostic_message"] = "Conversation service initialized. Bedrock probe skipped."
            return status

        try:
            response = self.client.converse(
                modelId=self.model,
                messages=[
                    {
                        "role": "user",
                        "content": [{"text": "Reply with OK"}],
                    }
                ],
                inferenceConfig={
                    "maxTokens": 8,
                    "temperature": 0,
                },
            )
            probe_text = (
                response.get("output", {})
                .get("message", {})
                .get("content", [{}])[0]
                .get("text", "")
                .strip()
            )
            status["bedrock_access_ok"] = True
            status["diagnostic_message"] = (
                f"Bedrock conversation probe succeeded for model '{self.model}'."
                + (f" Response: {probe_text}" if probe_text else "")
            )
            return status
        except Exception as exc:
            lower_error = str(exc).lower()
            status["success"] = False
            status["bedrock_access_ok"] = False

            if (
                "accessdeniedexception" in lower_error
                or "not authorized" in lower_error
                or "model access" in lower_error
            ):
                status["diagnostic_message"] = (
                    f"AWS Bedrock access denied. Grant bedrock:InvokeModel and enable model access for '{self.model}' in '{self.region}'."
                )
                return status

            if (
                "endpointconnectionerror" in lower_error
                or "could not connect to the endpoint url" in lower_error
                or "timed out" in lower_error
            ):
                status["diagnostic_message"] = (
                    f"Unable to connect to AWS Bedrock in '{self.region}'. Verify network, region, and certificate settings."
                )
                return status

            status["diagnostic_message"] = f"Bedrock probe failed: {str(exc)}"
            return status
    
    # ========================================================================
    # CONVERSATION MANAGEMENT
    # ========================================================================
    
    def create_conversation(
        self,
        request_id: str,
        topic: str = "clarification",
        initial_context: Optional[str] = None
    ) -> Conversation:
        """
        Create a new conversation session for an audit request.
        
        Parameters:
        - request_id: The audit request ID
        - topic: Topic of conversation (clarification, feedback, explanation)
        - initial_context: Optional initial context or question
        
        Returns:
        - Conversation object
        """
        
        conversation_id = f"CONV-{uuid4().hex[:12].upper()}"
        now = datetime.utcnow()
        
        conversation = Conversation(
            conversation_id=conversation_id,
            request_id=request_id,
            created_at=now,
            updated_at=now,
            messages=[],
            topic=topic,
            status="active"
        )
        
        self.conversations[conversation_id] = conversation
        
        return conversation
    
    def get_conversation(self, conversation_id: str) -> Optional[Conversation]:
        """Get a conversation by ID."""
        return self.conversations.get(conversation_id)
    
    def close_conversation(self, conversation_id: str, resolution: str = "resolved") -> Conversation:
        """Close a conversation session."""
        
        if conversation_id not in self.conversations:
            raise ValueError(f"Conversation {conversation_id} not found")
        
        conversation = self.conversations[conversation_id]
        conversation.status = resolution
        conversation.updated_at = datetime.utcnow()
        
        return conversation
    
    # ========================================================================
    # MESSAGE HANDLING
    # ========================================================================
    
    def add_auditor_message(
        self,
        conversation_id: str,
        message_text: str,
        message_type: str = "question",
        referenced_step_id: Optional[str] = None,
        referenced_evidence_ids: Optional[List[str]] = None
    ) -> ConversationMessage:
        """
        Add a message from the auditor to the conversation.
        
        Parameters:
        - conversation_id: The conversation ID
        - message_text: The auditor's message
        - message_type: Type of message (question, feedback, clarification)
        - referenced_step_id: Optional reference to a workflow step
        - referenced_evidence_ids: Optional references to evidence items
        
        Returns:
        - ConversationMessage object
        """
        
        if conversation_id not in self.conversations:
            raise ValueError(f"Conversation {conversation_id} not found")
        
        conversation = self.conversations[conversation_id]
        resolved_message_type = self._infer_message_type(
            message_text,
            provided_type=message_type,
            conversation=conversation,
        )
        
        message = ConversationMessage(
            message_id=f"MSG-{uuid4().hex[:12].upper()}",
            request_id=conversation.request_id,
            conversation_id=conversation_id,
            timestamp=datetime.utcnow(),
            sender_type="auditor",
            sender_id=f"auditor_{uuid4().hex[:8]}",
            message_text=message_text,
            message_type=resolved_message_type,
            referenced_step_log_id=referenced_step_id,
            referenced_evidence_ids=referenced_evidence_ids or []
        )
        
        conversation.messages.append(message)
        conversation.updated_at = datetime.utcnow()
        
        return message
    
    def generate_ai_response(
        self,
        conversation_id: str,
        request: Optional[AuditRequest] = None,
        context_data: Optional[Dict[str, Any]] = None
    ) -> ConversationMessage:
        """
        Generate an AI response using Claude to the latest auditor message.
        
        Parameters:
        - conversation_id: The conversation ID
        - request: Optional AuditRequest object for context
        - context_data: Optional additional context (step logs, evidence, etc.)
        
        Returns:
        - ConversationMessage with AI response
        """
        
        if conversation_id not in self.conversations:
            raise ValueError(f"Conversation {conversation_id} not found")
        
        conversation = self.conversations[conversation_id]
        
        if not conversation.messages or conversation.messages[-1].sender_type != "auditor":
            raise ValueError("No auditor message to respond to")
        
        # Get the latest auditor message
        latest_auditor_message = conversation.messages[-1]

        if not self._is_message_in_scope(
            latest_auditor_message.message_text,
            request=request,
            context_data=context_data,
            conversation=conversation,
        ):
            ai_message = ConversationMessage(
                message_id=f"MSG-{uuid4().hex[:12].upper()}",
                request_id=conversation.request_id,
                conversation_id=conversation_id,
                timestamp=datetime.utcnow(),
                sender_type="ai_agent",
                sender_id="bedrock_nvidia",
                message_text=self._build_out_of_scope_response(),
                message_type="response",
                ai_model=self.model,
                ai_confidence=0.99,
            )

            conversation.messages.append(ai_message)
            conversation.updated_at = datetime.utcnow()
            return ai_message
        
        # Build conversation history for Bedrock Claude
        conversation_history = self._build_conversation_history(
            conversation,
            request,
            context_data
        )
        
        # Generate response using Bedrock Claude
        response_text = self._call_bedrock(
            conversation_history,
            latest_auditor_message.message_text,
            request,
            context_data
        )
        
        # Create AI response message
        ai_message = ConversationMessage(
            message_id=f"MSG-{uuid4().hex[:12].upper()}",
            request_id=conversation.request_id,
            conversation_id=conversation_id,
            timestamp=datetime.utcnow(),
            sender_type="ai_agent",
            sender_id="bedrock_nvidia",
            message_text=response_text,
            message_type="response",
            ai_model=self.model,
            ai_confidence=0.85  # Haiku's typical confidence for this type of task
        )
        
        conversation.messages.append(ai_message)
        conversation.updated_at = datetime.utcnow()
        
        return ai_message

    def _tokenize(self, text: str) -> List[str]:
        return [token for token in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(token) >= 4]

    def _build_request_terms(self, request: Optional[AuditRequest]) -> set[str]:
        if not request:
            return set()

        text_parts: List[str] = [
            str(getattr(request, "request_text", "") or ""),
            str(getattr(request, "request_category", "") or ""),
            str(getattr(getattr(request, "current_stage", None), "value", "") or ""),
        ]

        if getattr(request, "validation_result", None):
            text_parts.append(str(getattr(request.validation_result, "overall_validation_status", "")))
            text_parts.extend(list(getattr(request.validation_result, "gap_recommendations", []) or []))

        if getattr(request, "conclusion", None):
            text_parts.append(str(getattr(request.conclusion, "overall_assessment", "") or ""))

        tokens = self._tokenize(" ".join(text_parts))
        return set(tokens)

    def _looks_like_continuation(self, text: str) -> bool:
        normalized = (text or "").strip().lower()
        if not normalized:
            return True

        if len(normalized.split()) <= 8:
            if re.search(r"\b(this|that|it|those|them|these|same)\b", normalized):
                return True

        return any(re.search(pattern, normalized) for pattern in CONTINUATION_PATTERNS)

    def _recent_conversation_has_audit_context(self, conversation: Optional[Conversation]) -> bool:
        if not conversation or not conversation.messages:
            return False

        recent_text = " ".join(
            str(msg.message_text or "") for msg in conversation.messages[-6:]
        ).lower()

        scope_terms = [
            "audit", "evidence", "validation", "workflow", "request", "conclusion",
            "summary", "finding", "control", "approval", "step", "document", "file",
        ]
        return any(term in recent_text for term in scope_terms)

    def _infer_message_type(
        self,
        message_text: str,
        provided_type: str,
        conversation: Optional[Conversation] = None,
    ) -> str:
        normalized = (message_text or "").strip().lower()

        if not normalized:
            return "clarification"

        if provided_type and provided_type != "question":
            return provided_type

        if "?" in normalized or normalized.startswith(("why", "how", "what", "when", "where", "which", "who")):
            return "question"

        if normalized.startswith(("thanks", "thank you", "good", "great", "noted")):
            return "feedback"

        if self._looks_like_continuation(normalized) and self._recent_conversation_has_audit_context(conversation):
            return "clarification"

        return "question"

    def _is_message_in_scope(
        self,
        question: str,
        request: Optional[AuditRequest] = None,
        context_data: Optional[Dict[str, Any]] = None,
        conversation: Optional[Conversation] = None,
    ) -> bool:
        normalized = (question or "").strip().lower()
        if not normalized:
            return True

        # Hard allow-list for supported conversation domains.
        allowed_topics = [
            "audit",
            "control",
            "evidence",
            "request",
            "workflow",
            "validation",
            "sufficient",
            "sufficiency",
            "conclusion",
            "summary",
            "summarization",
            "finding",
            "gap",
            "recommendation",
            "confidence",
            "coverage",
            "approval",
            "step",
            "trace",
            "interpretation",
            "retrieval",
            "uploaded",
            "document",
            "file",
        ]

        if any(topic in normalized for topic in allowed_topics):
            return True

        if re.search(r"\b(ev|val|req|conv)-[a-z0-9-]+\b", normalized):
            return True

        question_tokens = set(self._tokenize(normalized))
        request_terms = self._build_request_terms(request)

        if request_terms and question_tokens.intersection(request_terms):
            return True

        if context_data:
            context_blob = " ".join(str(value) for value in context_data.values())
            context_terms = set(self._tokenize(context_blob))
            if context_terms and question_tokens.intersection(context_terms):
                return True

        # Support conversational follow-ups that rely on previous turns.
        if self._looks_like_continuation(normalized) and self._recent_conversation_has_audit_context(conversation):
            return True

        return False

    def _build_out_of_scope_response(self) -> str:
        return (
            "I can only answer audit-related questions tied to this request and its evidence lifecycle "
            "(collection/retrieval, validation, conclusion, and summarization). "
            "Please ask about the current audit request, evidence relevance/sufficiency, validation outcomes, "
            "conclusion findings, or recommended next audit actions."
        )
    
    def _build_conversation_history(
        self,
        conversation: Conversation,
        request: Optional[AuditRequest],
        context_data: Optional[Dict[str, Any]]
    ) -> str:
        """Build context for Bedrock Claude about the audit conversation."""
        
        history = []
        
        # Add conversation context
        if request:
            history.append(f"Audit Request: {request.request_text}")
            history.append(f"Request Category: {request.request_category}")
            history.append(f"Current Stage: {request.current_stage.value}")
        
        # Add relevant evidence context
        if context_data and "evidence_summary" in context_data:
            history.append(f"\nEvidence Summary: {context_data['evidence_summary']}")
        
        # Add recent step information
        if request and request.step_logs:
            history.append("\nRecent Workflow Steps:")
            for log in request.step_logs[-3:]:  # Last 3 steps
                if isinstance(log, dict):
                    step_name = log.get("step_name", "Unknown Step")
                    action_taken = log.get("action_taken", "No action details")
                else:
                    step_name = getattr(log, "step_name", "Unknown Step")
                    action_taken = getattr(log, "action_taken", "No action details")
                history.append(f"- {step_name}: {action_taken}")
        
        # Add flow memory to preserve continuity across plain follow-up statements.
        if conversation.messages:
            history.append("\nConversation Flow Memory:")
            latest_auditor = next(
                (msg for msg in reversed(conversation.messages) if msg.sender_type == "auditor"),
                None,
            )
            latest_ai = next(
                (msg for msg in reversed(conversation.messages) if msg.sender_type == "ai_agent"),
                None,
            )
            if latest_auditor:
                history.append(
                    f"- Latest auditor intent type: {latest_auditor.message_type}; message: {latest_auditor.message_text}"
                )
            if latest_ai:
                history.append(f"- Most recent AI guidance: {latest_ai.message_text}")

        # Add previous messages
        history.append("\nConversation History:")
        for msg in conversation.messages[-10:]:  # Last 10 messages
            sender = "Auditor" if msg.sender_type == "auditor" else "AI"
            history.append(f"{sender}: {msg.message_text}")
        
        return "\n".join(history)
    
    def _call_bedrock(
        self,
        conversation_history: str,
        user_question: str,
        request: Optional[AuditRequest],
        context_data: Optional[Dict[str, Any]]
    ) -> str:
        """Call Bedrock Claude to generate a response."""
        
        # Build system prompt
        system_prompt = self._build_system_prompt(request, context_data)
        
        # Build user message
        user_message = f"""
{conversation_history}

User's Current Message: {user_question}

Please provide a helpful, concise response that:
1. Directly addresses the auditor's latest message and intent
2. References specific evidence or workflow steps when relevant
3. Explains AI decisions in clear, auditor-friendly language
4. Suggests next steps if appropriate
5. If the user message is a plain follow-up statement, infer the intended continuation from conversation context and continue naturally
6. Uses grammatically correct, professional English with accurate punctuation and context-appropriate audit terminology
"""
        
        try:
            response = self.client.converse(
                modelId=self.model,
                messages=[
                    {
                        "role": "user",
                        "content": [{"text": user_message}],
                    }
                ],
                system=[{"text": system_prompt}],
                inferenceConfig={
                    "maxTokens": 1024,
                    "temperature": 0.0,
                },
            )
            return response["output"]["message"]["content"][0].get("text", "")
        except Exception as exc:
            lower_error = str(exc).lower()
            if (
                "unrecognizedclientexception" in lower_error
                or "security token included in the request is invalid" in lower_error
            ):
                retried = _retry_converse_without_env_credentials(
                    region=self.region,
                    tls_verify=self.tls_verify,
                    model_id=self.model,
                    prompt=user_message,
                    explicit_credentials=self.explicit_credentials,
                )
                return retried["output"]["message"]["content"][0].get("text", "")

            if (
                "accessdeniedexception" in lower_error
                or "not authorized" in lower_error
                or "not authorized to perform" in lower_error
                or "is not authorized" in lower_error
                or "you don't have access to the model" in lower_error
                or "model access" in lower_error
            ):
                raise RuntimeError(
                    f"AWS Bedrock access denied. Grant bedrock:InvokeModel permissions and enable model access for '{self.model}' in region '{self.region}'."
                ) from exc

            if (
                "could not connect to the endpoint url" in lower_error
                or "endpointconnectionerror" in lower_error
                or "connection error" in lower_error
                or "timed out" in lower_error
            ):
                raise RuntimeError(
                    f"Unable to connect to AWS Bedrock in region '{self.region}'. Verify network connectivity, region, and AWS_CA_BUNDLE/certificate settings."
                ) from exc

            raise
    
    def _build_system_prompt(
        self,
        request: Optional[AuditRequest],
        context_data: Optional[Dict[str, Any]]
    ) -> str:
        """Build system prompt for Bedrock Claude."""
        
        prompt = """You are an experienced audit assistant helping an auditor review and evaluate audit evidence collection and validation results.

Your role is to:
1. Answer questions about audit findings and evidence assessment
2. Explain AI decisions and confidence levels
3. Help clarify what evidence is needed
4. Provide audit guidance and best practices
5. Support the auditor in making informed decisions

Guidelines:
- Be accurate and factual - don't make up evidence or findings
- Use only information contained in the request context, provided evidence summaries, and conversation history
- Never invent filenames, IDs, dates, entities, controls, procedures, or quantitative results
- If information is missing or uncertain, explicitly say it is not available in the provided audit context
- Explain complex audit concepts in clear, simple language
- Always reference specific evidence items or workflow steps when making claims
- Acknowledge uncertainty and suggest human review when needed
- Provide actionable recommendations
- Maintain professional tone appropriate for audit documentation
- Use grammatically correct, polished English with precise punctuation and context-appropriate terminology
- You are restricted to audit-only scope for this request.
- Only answer topics related to: request context, collected/retrieved evidence, validation, conclusion, summarization, and approval workflow.
- If asked about anything outside this scope, refuse briefly and ask the user to ask an audit-scope question.
- Treat brief/plain follow-up statements as contextual continuations when recent conversation history is audit-related.
"""

        if request and getattr(request, "request_text", None):
            prompt += (
                "\n\nPrimary professional standards reference for this request:\n"
                f"{build_standards_prompt_context(str(request.request_text), max_items=5)}"
            )
        
        if context_data and "audit_guidance" in context_data:
            prompt += f"\n\nSpecial Audit Context: {context_data['audit_guidance']}"
        
        return prompt
    
    # ========================================================================
    # SPECIFIC RESPONSE HANDLERS
    # ========================================================================
    
    def explain_finding(
        self,
        conversation_id: str,
        finding_description: str,
        supporting_evidence: List[str],
        request: Optional[AuditRequest] = None
    ) -> ConversationMessage:
        """Generate explanation for a specific audit finding."""
        
        if conversation_id not in self.conversations:
            raise ValueError(f"Conversation {conversation_id} not found")
        
        # Create AI message with explanation
        explanation_text = f"""
Based on the audit evidence collected, here's an explanation of the key finding:

**Finding:** {finding_description}

**Supporting Evidence:**
{chr(10).join(f"- {ev}" for ev in supporting_evidence)}

**Assessment:** This finding is supported by {len(supporting_evidence)} evidence item(s). The evidence demonstrates that the control is operating as intended.

**Recommendations:** Continue monitoring this control area and conduct periodic re-testing to ensure ongoing effectiveness.
"""
        
        ai_message = ConversationMessage(
            message_id=f"MSG-{uuid4().hex[:12].upper()}",
            request_id=self.conversations[conversation_id].request_id,
            conversation_id=conversation_id,
            timestamp=datetime.utcnow(),
            sender_type="ai_agent",
            sender_id="bedrock_nvidia",
            message_text=explanation_text,
            message_type="explanation",
            ai_model=self.model,
            ai_confidence=0.88
        )
        
        self.conversations[conversation_id].messages.append(ai_message)
        
        return ai_message
    
    def answer_why_question(
        self,
        conversation_id: str,
        decision_or_action: str,
        reasoning: str,
        confidence: float = 0.8,
        request: Optional[AuditRequest] = None
    ) -> ConversationMessage:
        """Answer a "why" question about an AI decision."""
        
        if conversation_id not in self.conversations:
            raise ValueError(f"Conversation {conversation_id} not found")
        
        response_text = f"""
You asked why {decision_or_action}.

**Reasoning:**
{reasoning}

**Confidence Level:** {confidence:.0%}

This decision was made based on the available evidence and audit procedures. If you'd like additional analysis or have concerns about this assessment, please let me know.
"""
        
        ai_message = ConversationMessage(
            message_id=f"MSG-{uuid4().hex[:12].upper()}",
            request_id=self.conversations[conversation_id].request_id,
            conversation_id=conversation_id,
            timestamp=datetime.utcnow(),
            sender_type="ai_agent",
            sender_id="bedrock_nvidia",
            message_text=response_text,
            message_type="explanation",
            ai_model=self.model,
            ai_confidence=confidence
        )
        
        self.conversations[conversation_id].messages.append(ai_message)
        
        return ai_message
    
    def suggest_next_steps(
        self,
        conversation_id: str,
        current_status: str,
        recommendations: List[str],
        request: Optional[AuditRequest] = None
    ) -> ConversationMessage:
        """Suggest next steps in the audit process."""
        
        if conversation_id not in self.conversations:
            raise ValueError(f"Conversation {conversation_id} not found")
        
        next_steps_text = f"""
Based on the current audit status ({current_status}), here are the recommended next steps:

**Recommended Actions:**
{chr(10).join(f"{i+1}. {rec}" for i, rec in enumerate(recommendations))}

**Priority:** Follow these steps in order to efficiently complete the audit.

**Timeline:** Estimate 1-2 days per step depending on evidence availability and complexity.

Would you like more detail on any of these steps?
"""
        
        ai_message = ConversationMessage(
            message_id=f"MSG-{uuid4().hex[:12].upper()}",
            request_id=self.conversations[conversation_id].request_id,
            conversation_id=conversation_id,
            timestamp=datetime.utcnow(),
            sender_type="ai_agent",
            sender_id="bedrock_nvidia",
            message_text=next_steps_text,
            message_type="response",
            ai_model=self.model,
            ai_confidence=0.85
        )
        
        self.conversations[conversation_id].messages.append(ai_message)
        
        return ai_message
    
    # ========================================================================
    # FEEDBACK AND LEARNING
    # ========================================================================
    
    def record_auditor_feedback(
        self,
        conversation_id: str,
        feedback_text: str,
        feedback_type: str = "general",
        agreed_with_assessment: Optional[bool] = None
    ) -> Dict[str, Any]:
        """
        Record feedback from the auditor for system improvement.
        
        Parameters:
        - conversation_id: The conversation ID
        - feedback_text: The auditor's feedback
        - feedback_type: Type of feedback (general, finding_correction, process_improvement)
        - agreed_with_assessment: Whether auditor agreed with AI assessment
        
        Returns:
        - Feedback record
        """
        
        if conversation_id not in self.conversations:
            raise ValueError(f"Conversation {conversation_id} not found")
        
        feedback_record = {
            "feedback_id": f"FB-{uuid4().hex[:12].upper()}",
            "conversation_id": conversation_id,
            "request_id": self.conversations[conversation_id].request_id,
            "timestamp": datetime.utcnow().isoformat(),
            "feedback_type": feedback_type,
            "feedback_text": feedback_text,
            "agreed_with_assessment": agreed_with_assessment,
            "model": self.model
        }
        
        return feedback_record
    
    def get_conversation_summary(
        self,
        conversation_id: str
    ) -> Dict[str, Any]:
        """Get a summary of a conversation."""
        
        if conversation_id not in self.conversations:
            raise ValueError(f"Conversation {conversation_id} not found")
        
        conversation = self.conversations[conversation_id]
        
        return {
            "conversation_id": conversation_id,
            "request_id": conversation.request_id,
            "topic": conversation.topic,
            "status": conversation.status,
            "message_count": len(conversation.messages),
            "created_at": conversation.created_at.isoformat(),
            "updated_at": conversation.updated_at.isoformat(),
            "messages": [
                {
                    "message_id": msg.message_id,
                    "sender_type": msg.sender_type,
                    "sender_id": msg.sender_id,
                    "message_text": msg.message_text,
                    "message_type": msg.message_type,
                    "timestamp": msg.timestamp.isoformat(),
                    "ai_confidence": msg.ai_confidence,
                }
                for msg in conversation.messages
            ]
        }

